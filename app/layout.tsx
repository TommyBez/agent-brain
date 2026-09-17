import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const sans = localFont({
  src: "./fonts/dm-sans.ttf",
  variable: "--font-interface",
  display: "swap",
  weight: "100 1000",
});
const serif = localFont({
  src: "./fonts/lora.ttf",
  variable: "--font-editorial",
  display: "swap",
  weight: "400 700",
});

export const metadata: Metadata = {
  title: "a native brain",
  description: "A private knowledge workspace for you and your agents.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${serif.variable}`}
      data-scroll-behavior="smooth"
    >
      <body>{children}</body>
    </html>
  );
}
