import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { AppShell } from "@/components/layout/app-shell";
import { getI18n } from "@/i18n/server";
import { I18nProvider } from "@/i18n/provider";
import { sourceUrl } from "@/lib/source-url";
import { version } from "../../package.json";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getI18n();
  return {
    title: {
      default: "Unifi Protect Archive UI",
      template: "%s · Unifi Protect Archive UI",
    },
    applicationName: "Unifi Protect Archive UI",
    description: t("metadata.description"),
  };
}

export const viewport: Viewport = {
  themeColor: "#f3f5fa",
  viewportFit: "cover",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const { locale, messages } = await getI18n();
  return (
    <html lang={locale} className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
      <body>
        <I18nProvider locale={locale} messages={messages}>
          <AppShell version={process.env.APP_BUILD_VERSION || version} sourceUrl={sourceUrl(process.env.APP_SOURCE_URL) ?? sourceUrl(process.env.IMAGE_SOURCE_URL)}>{children}</AppShell>
        </I18nProvider>
      </body>
    </html>
  );
}
