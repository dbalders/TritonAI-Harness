# File attachments

TritonAI accepts images and regular files in the web and desktop chat composer. Use the paperclip,
paste files, or drop them onto the composer. A message can contain up to eight attachments totaling
50 MB. Images retain their existing 10 MB per-image limit.

Images are sent through each provider's image-input path. Other files are uploaded to the selected
environment and stored with the thread. The agent receives the file's local path and decides which
tools to use to inspect it. This keeps PDFs, documents, spreadsheets, archives, source files, and
future formats on one path-backed attachment system instead of extracting every format in the UI.

Uploads are scoped to an existing thread and reclaimed if the send fails before the file is used.
Unreferenced uploads expire after one hour and are capped at 50 MB per thread and 500 MB across the
environment while pending.
Regular files are served back as downloads; only validated image attachments can render inline.

File contents are not automatically pasted into the prompt. Treat an attachment like a local file
you handed to the agent: ask it to read, summarize, compare, convert, or otherwise work with it.

Mobile currently shows regular files in message history; selecting new non-image files is available
from the web and desktop composer.
