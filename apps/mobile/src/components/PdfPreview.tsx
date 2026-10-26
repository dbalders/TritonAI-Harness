import { useEffect, useState } from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";

import { preparePdfPreview } from "../lib/pdfPreview";
import { FilePreviewLoading, FilePreviewNotice } from "../features/files/FilePreviewFeedback";

export function PdfPreview(props: { readonly uri: string }) {
  const [error, setError] = useState<string | null>(null);
  const [localUri, setLocalUri] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let file: Awaited<ReturnType<typeof preparePdfPreview>> = null;
    void preparePdfPreview(props.uri, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) {
          result?.dispose();
          return;
        }
        file = result;
        setLocalUri(result?.uri ?? null);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("The PDF could not be loaded. Reopen the file to try again.");
      });
    return () => {
      controller.abort();
      file?.dispose();
    };
  }, [props.uri]);
  if (localUri === null && error === null)
    return <FilePreviewLoading message="Loading PDF..." background="card" />;
  return (
    <View className="flex-1 bg-card">
      {error ? <FilePreviewNotice title="Could not load PDF">{error}</FilePreviewNotice> : null}
      <WebView
        source={{
          uri:
            localUri === null
              ? "about:blank"
              : `${localUri}${props.uri.includes("#") ? props.uri.slice(props.uri.indexOf("#")) : ""}`,
        }}
        originWhitelist={["*"]}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        startInLoadingState
        onError={(event) =>
          setError(event.nativeEvent.description || "The PDF could not be loaded.")
        }
        onHttpError={(event) =>
          setError(`The server returned HTTP ${event.nativeEvent.statusCode}.`)
        }
        renderLoading={() => <FilePreviewLoading message="Loading PDF..." background="card" />}
        style={{ flex: 1, backgroundColor: "transparent" }}
      />
    </View>
  );
}
