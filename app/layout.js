import "./globals.css";

export const metadata = {
  title: "Support Evaluation Pipeline",
  description: "Replayable customer-support evaluation pipeline built for Vercel and Groq.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
