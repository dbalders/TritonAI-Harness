# Organizing threads

Pin a thread from its context menu to keep it in the pinned section above your active work.
Pinned threads are shown independently of their project, including when you connect to more than
one environment.

Pinned threads still move to **Settled** when they become inactive. They also move when their pull
request merges if **Auto-settle merged threads** is enabled.

Right-click a pull request link in a thread and choose **Link to thread** to show that pull request
in the sidebar. The thread settles when the linked pull request merges if **Auto-settle merged
threads** is enabled. Right-click the same link and choose **Unlink from thread** to remove it.

On web and desktop, drag a pinned thread to change its position. On mobile, open the thread's menu
and choose **Move up** or **Move down**. The order is stored by the server and appears on your
other connected devices.

If reordering is unavailable for one environment, update the T3 Code server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

Active threads are grouped by project on web and desktop. Projects follow your project sort setting:
your saved order when sorting is manual, and most recent activity otherwise. Each project shows its
most recently active thread first. Use the project filter above the list to focus the sidebar on one
project. Branch, provider, and environment details remain available by hovering a thread without
taking up space in every row.

Unsent drafts appear in a separate **Draft threads** section above Active threads. The section is
hidden when there are no saved drafts, keeping draft work distinct from submitted threads.
