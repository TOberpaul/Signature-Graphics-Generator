import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Signature Graphics Generator",
  description:
    "Macht aus einer Silhouette eine Signature Graphic nach den Regeln der DB. Läuft vollständig im Browser, Export als SVG oder PNG.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body>{children}</body>
    </html>
  );
}
