import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppRail } from "@/components/shell/app-rail";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Creator Lab",
  description: "An open-source studio for creators who make short vertical content around a single product, on their own Comfy account.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <ThemeProvider>
          <div className="flex min-h-screen min-w-[1024px] bg-background text-foreground">
            <AppRail />
            <main className="min-w-0 flex-1">{children}</main>
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
