import ChatMarkdown from "../ChatMarkdown";
import { remarkBotImagesAsLinks } from "./botMarkdown";

const BOT_REMARK_PLUGINS = [remarkBotImagesAsLinks];

/**
 * A bot reply can quote email, chat and file text someone else wrote. It renders as Markdown only: raw HTML shows
 * as text and images become links, so nothing in a reply loads a remote address on its own.
 */
export function BotReplyMarkdown({ text }: { readonly text: string }) {
  return (
    <ChatMarkdown
      text={text}
      cwd={undefined}
      lineBreaks
      parseRawHtml={false}
      extraRemarkPlugins={BOT_REMARK_PLUGINS}
    />
  );
}
