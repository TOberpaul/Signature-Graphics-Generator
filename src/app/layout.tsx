import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Bar Illustration Generator",
  description:
    "Reduzierte Balkengrafiken aus Texteingabe - abstrahiert von der lokalen Kiro CLI, gerendert deterministisch als SVG.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body>{children}</body>
    </html>
  );
}
