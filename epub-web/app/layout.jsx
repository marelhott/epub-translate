import { Fraunces, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const display = Fraunces({
  subsets: ["latin"],
  weight: ["300", "400"],
  variable: "--font-display"
});

const body = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-body"
});

export const metadata = {
  title: "EPUB Web",
  description: "Commercial shell sandbox for the EPUB translation workspace."
};

export default function RootLayout({ children }) {
  return (
    <html lang="cs">
      <body className={`${display.variable} ${body.variable}`}>{children}</body>
    </html>
  );
}
