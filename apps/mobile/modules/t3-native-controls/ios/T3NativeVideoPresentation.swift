import AVKit
import UIKit

final class T3NativeVideoPresentation: NSObject, AVPlayerViewControllerDelegate,
  UIAdaptivePresentationControllerDelegate {
  let identifier: String
  private let controller = AVPlayerViewController()
  private let completion: (Error?) -> Void
  private let requestRefresh: (() -> Void)?
  private var refreshTimeout: DispatchWorkItem?
  private var refreshAttempts = 0
  private var failedPosition: CMTime?
  private struct PlaybackSnapshot {
    let position: CMTime
    let rate: Float
    var shouldPlay: Bool
  }
  private var pendingPlayback: PlaybackSnapshot?
  private var itemObservation: NSKeyValueObservation?
  private var backgroundObserver: NSObjectProtocol?
  private var playbackError: Error?
  private var restoredReplacement: AVPlayerItem?
  private var presented = false
  private var dismissRequested = false
  private var finished = false
  private struct AudioSessionConfiguration {
    let category: AVAudioSession.Category
    let mode: AVAudioSession.Mode
    let options: AVAudioSession.CategoryOptions

    init(_ session: AVAudioSession) {
      category = session.category
      mode = session.mode
      options = session.categoryOptions
    }
  }
  private var previousAudioSession: AudioSessionConfiguration?
  private weak var fullScreenController: UIViewController?
  private var embedded = false

  init(identifier: String, url: URL, title: String, requestRefresh: (() -> Void)?, completion: @escaping (Error?) -> Void) {
    self.identifier = identifier
    self.completion = completion
    self.requestRefresh = requestRefresh
    super.init()

    let item = AVPlayerItem(url: url)
    let metadata = AVMutableMetadataItem()
    metadata.identifier = .commonIdentifierTitle
    metadata.value = title as NSString
    item.externalMetadata = [metadata]
    controller.player = AVPlayer(playerItem: item)
    controller.delegate = self
    controller.overrideUserInterfaceStyle = .dark
    controller.allowsPictureInPicturePlayback = false

    itemObservation = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
      guard item.status == .failed else { return }
      DispatchQueue.main.async {
        guard let self else { return }
        guard self.controller.player?.currentItem === item else { return }
        self.handleFailure(item.error ?? URLError(.cannotLoadFromNetwork))
      }
    }
    backgroundObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
    ) { [weak self] _ in
      self?.pendingPlayback?.shouldPlay = false
      self?.controller.player?.pause()
    }
  }

  private func handleFailure(_ error: Error) {
    playbackError = error
    guard let requestRefresh, refreshAttempts < 1 else { dismiss(); return }
    refreshAttempts += 1
    failedPosition = controller.player?.currentTime()
    let timeout = DispatchWorkItem { [weak self] in self?.dismiss() }
    refreshTimeout = timeout
    DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: timeout)
    requestRefresh()
  }

  func replaceURL(_ url: URL) {
    guard !finished, let player = controller.player,
      (player.currentItem?.asset as? AVURLAsset)?.url != url else { return }
    if pendingPlayback == nil {
      pendingPlayback = PlaybackSnapshot(
        position: failedPosition ?? player.currentTime(), rate: player.rate,
        shouldPlay: player.rate > 0
      )
    }
    guard let playback = pendingPlayback else { return }
    failedPosition = nil
    let metadata = player.currentItem?.externalMetadata ?? []
    let item = AVPlayerItem(url: url)
    item.externalMetadata = metadata
    itemObservation = nil
    player.replaceCurrentItem(with: item)
    itemObservation = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
      DispatchQueue.main.async {
        guard let self, !self.finished, player.currentItem === item else { return }
        if item.status == .failed {
          self.handleFailure(item.error ?? URLError(.cannotLoadFromNetwork))
        } else if item.status == .readyToPlay && self.restoredReplacement !== item {
          self.restoredReplacement = item
          let target = playback.position.isNumeric && playback.position.seconds >= 0
            ? playback.position : .zero
          player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero) { complete in
            DispatchQueue.main.async {
              guard !self.finished, !self.dismissRequested,
                player.currentItem === item, item.status == .readyToPlay else { return }
              let shouldPlay = self.pendingPlayback?.shouldPlay == true
              self.pendingPlayback = nil
              self.playbackError = nil
              self.refreshTimeout?.cancel()
              self.refreshTimeout = nil
              // A newer user seek interrupts this seek; keep the user's current playback state.
              guard complete else { return }
              if shouldPlay && UIApplication.shared.applicationState == .active {
                player.playImmediately(atRate: playback.rate)
              } else {
                player.pause()
              }
            }
          }
        }
      }
    }
  }

  func present(from presenter: UIViewController, sources: T3PresentationSources, sourceIdentifier: String) {
    let audioSession = AVAudioSession.sharedInstance()
    previousAudioSession = AudioSessionConfiguration(audioSession)
    do {
      try audioSession.setCategory(.playback, mode: .moviePlayback)
    } catch {
      NSLog("T3 video audio session: %@", error.localizedDescription)
    }
    // AVKit exposes programmatic inline-to-full-screen entry through this selector.
    // This is the same guarded entry point used by expo-video's enterFullscreen().
    let enterFullScreen = NSSelectorFromString("enterFullScreenAnimated:completionHandler:")
    if let source = sources.view(for: sourceIdentifier), source.window != nil,
      controller.responds(to: enterFullScreen) {
      // AVKit owns the transition from its inline view to full screen. Using a
      // separate UIKit zoom transition prevents its native Close action from exiting.
      var responder: UIResponder? = source
      while let current = responder, !(current is UIViewController) { responder = current.next }
      let parent = responder as? UIViewController ?? presenter
      embedded = true
      parent.addChild(controller)
      controller.view.frame = source.bounds
      controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      source.addSubview(controller.view)
      controller.didMove(toParent: parent)
      controller.view.layoutIfNeeded()
      controller.perform(enterFullScreen, with: true, with: nil)
      controller.player?.play()
    } else {
      presenter.present(controller, animated: true) { [self] in
        presented = true
        if dismissRequested {
          dismiss()
        } else if UIApplication.shared.applicationState == .active {
          controller.player?.play()
        }
      }
      controller.presentationController?.delegate = self
    }
  }

  func dismiss() {
    dismissRequested = true
    guard !finished else { return }
    guard presented else {
      if embedded && fullScreenController == nil { finish() }
      return
    }
    (fullScreenController ?? controller).dismiss(animated: true) { [self] in finish() }
  }

  func playerViewController(
    _ playerViewController: AVPlayerViewController,
    willBeginFullScreenPresentationWithAnimationCoordinator coordinator: UIViewControllerTransitionCoordinator
  ) {
    fullScreenController = coordinator.viewController(forKey: .to)
    coordinator.animate(alongsideTransition: nil) { [weak self] context in
      guard let self else { return }
      if context.isCancelled {
        finish()
      } else {
        presented = true
        if dismissRequested { dismiss() }
      }
    }
  }

  func playerViewController(
    _ playerViewController: AVPlayerViewController,
    willEndFullScreenPresentationWithAnimationCoordinator coordinator: UIViewControllerTransitionCoordinator
  ) {
    coordinator.animate(alongsideTransition: nil) { [weak self] context in
      if !context.isCancelled { self?.finish() }
    }
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    finish()
  }

  private func finish() {
    guard !finished else { return }
    finished = true
    refreshTimeout?.cancel()
    refreshTimeout = nil
    controller.player?.pause()
    if embedded {
      controller.willMove(toParent: nil)
      controller.view.removeFromSuperview()
      controller.removeFromParent()
    }
    itemObservation = nil
    pendingPlayback = nil
    controller.player = nil
    if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) }
    backgroundObserver = nil
    let audioSession = AVAudioSession.sharedInstance()
    // Still what present() set, allowing the .mixWithOthers flip expo-video
    // makes when the inline players pause under this preview. A recorder that
    // claimed the session since owns it.
    if let previousAudioSession, audioSession.category == .playback,
      audioSession.mode == .moviePlayback,
      audioSession.categoryOptions.isSubset(of: [.mixWithOthers]) {
      try? audioSession.setCategory(
        previousAudioSession.category,
        mode: previousAudioSession.mode,
        options: previousAudioSession.options
      )
      // Deactivating with notification lets interrupted apps resume.
      try? audioSession.setActive(false, options: [.notifyOthersOnDeactivation])
    }
    completion(playbackError)
  }
}
