import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gelp",
  description: "Browse your Google Maps saved lists.",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
