import type { Metadata, Viewport } from "next";
import { Geist_Mono, Inter, Inter_Tight } from "next/font/google";

import { AppShell } from "@/components/layout/app-shell";
import { getI18n } from "@/i18n/server";
import { I18nProvider } from "@/i18n/provider";
import { sourceUrl } from "@/lib/source-url";
import { version } from "../../package.json";
import "./globals.css";

// Atelier Soft type (DESIGN.md), self-hosted at build time by next/font: the browser never
// contacts Google. Inter and Geist Mono are variable fonts (one file each); headings only use
// Inter Tight 300, so that is the one static weight loaded.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const interTight = Inter_Tight({
  variable: "--font-inter-tight",
  subsets: ["latin"],
  weight: "300",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getI18n();
  return {
    title: {
      default: "Protect Archive UI",
      template: "%s · Protect Archive UI",
    },
    applicationName: "Protect Archive UI",
    description: t("metadata.description"),
  };
}

export const viewport: Viewport = {
  themeColor: "#fdfbf7",
  viewportFit: "cover",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const { locale, messages } = await getI18n();
  return (
    <html lang={locale} className={`${inter.variable} ${interTight.variable} ${geistMono.variable} antialiased`}>
      <body>
        <I18nProvider locale={locale} messages={messages}>
          <AppShell version={process.env.APP_BUILD_VERSION || version} sourceUrl={sourceUrl(process.env.APP_SOURCE_URL) ?? sourceUrl(process.env.IMAGE_SOURCE_URL)}>{children}</AppShell>
        </I18nProvider>
      </body>
    </html>
  );
}
