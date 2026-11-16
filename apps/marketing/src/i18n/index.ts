import { de } from "./de";
import { en, type Messages } from "./en";
import { es } from "./es";
import { fr } from "./fr";
import { ja } from "./ja";
import { ko } from "./ko";
import type { Locale } from "./locales";
import { ptBR } from "./pt-BR";
import { ru } from "./ru";
import { zh } from "./zh";

const MESSAGES: Record<Locale, Messages> = {
  en,
  es,
  "zh-Hans": zh,
  "pt-BR": ptBR,
  fr,
  de,
  ja,
  ko,
  ru,
};

export const messagesFor = (locale: Locale): Messages => {
  const messages = MESSAGES[locale];
  return {
    ...messages,
    home: {
      ...messages.home,
      heroSub:
        "A UC San Diego-focused workspace with a managed Codex engine connected to TritonAI.",
      harnessTitle: "Managed TritonAI access",
      harnessBody:
        "TritonAI Installer configures the managed runtime. Harness keeps upstream provider adapters available where your configuration supports them.",
      harnessPoints: [
        "Managed Codex setup.",
        "Switch models mid-thread.",
        "Reusable tools and skills.",
      ],
      ctaSub:
        "Install TritonAI Harness with TritonAI Installer and work with your configured models, tools, and skills.",
    },
    download: {
      ...messages.download,
      description:
        "Download TritonAI Harness through TritonAI Installer or the Harness GitHub releases.",
    },
  };
};
