import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/nav";
import { OtelStatusBadge } from "@/components/otel-status-badge";
import { QuotaNavWidget } from "@/components/quota/quota-nav-widget";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TokenFx",
  description: "TokenFx — dashboard pessoal de efetividade de tokens do Claude Code",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="pt-BR"
      className={`${geistSans.variable} ${geistMono.variable}`}
    >
      <body className="bg-neutral-950 text-neutral-100 antialiased min-h-screen">
        <Nav
          slot={
            <div className="flex items-center gap-3">
              <QuotaNavWidget />
              <OtelStatusBadge />
            </div>
          }
        />
        <main className="max-w-7xl mx-auto px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
