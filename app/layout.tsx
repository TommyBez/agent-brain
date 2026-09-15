import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Brain — a place for what you know",
  description:
    "Your private, connected knowledge. A second brain for you and your agents.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
