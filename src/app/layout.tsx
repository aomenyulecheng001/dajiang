import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/ui/theme-provider";
import { HtmlLang } from "@/components/html-lang";
import { Toaster } from "sonner";
import { BotRunnerProvider } from "@/lib/bot-runner-context";
import { ErrorBoundary } from "@/components/error-boundary";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Bot Factory - Telegram Bot Management Platform",
  description: "Build, manage, and monitor your Telegram bots with Bot Factory. Create intelligent chatbots with visual code editor, real-time monitoring, and powerful analytics.",
  keywords: ["Bot Factory", "Telegram", "Bot Management", "Chatbot", "No-Code"],
  icons: {
    // HTTP/HTTPS COMPAT: Use protocol-relative URL so the icon loads correctly
    // whether deployed on HTTP or HTTPS. Browsers resolve // to the current protocol.
    icon: "//z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <HtmlLang />
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <BotRunnerProvider>
            <ErrorBoundary>
              {children}
            </ErrorBoundary>
            <Toaster />
          </BotRunnerProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
