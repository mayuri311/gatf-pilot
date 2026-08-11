import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GATF Lot Dashboard",
  description: "Live occupancy and crossing events for the GATF parking lot",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
