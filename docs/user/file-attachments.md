# File attachments

TritonAI accepts images and regular files in the web and desktop chat composer. Use the paperclip,
paste files, or drop them onto the composer. A message can contain up to eight attachments. Images
retain their existing 10 MB per-image limit.

Images are sent through each provider's image-input path. In the desktop app, a file selected for a
native local environment stays in place: Electron supplies its original filesystem path and the
agent decides which tools to use to inspect it. TritonAI does not read, encode, or copy that file,
and it does not impose a generic-file size limit on this path-backed flow.

When the original path is not reachable by the selected environment—such as SSH, WSL, or a regular
browser client—the file is uploaded to that environment and stored with the thread. Fallback
file uploads are limited to 50 MB per file, and all uploaded attachments are limited to 50 MB
combined per message. This keeps PDFs, documents, spreadsheets, archives, source files, and future
formats on one agent-directed attachment system without extracting every format in the UI.

Uploads are scoped to an existing thread and reclaimed if the send fails before the file is used.
Unreferenced uploads expire after one hour and are capped at 50 MB per thread and 500 MB across the
environment while pending.
Stored files are served back as downloads. Direct local references remain filename chips in history;
only validated image attachments can render inline.

File contents are not automatically pasted into the prompt. Treat an attachment like a local file
you handed to the agent: ask it to read, summarize, compare, convert, or otherwise work with it.

Mobile currently shows regular files in message history; selecting new non-image files is available
from the web and desktop composer.
