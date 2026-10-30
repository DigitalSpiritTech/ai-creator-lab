import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { DemoBanner, DemoProvider, JudgeBanner } from "@/components/demo-mode";
import { AppRail } from "@/components/shell/app-rail";
import { hostedMode } from "@/server/demo";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Creator Lab",
  description: "An open-source studio for creators who make short vertical content around a single product, on their own Comfy account.",
};

const REPOSITORY = "https://github.com/DigitalSpiritTech/ai-creator-lab";

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Rendered per request, not at build time, so the read-only demo flag is read where the app runs.
  await connection();
  const mode = hostedMode();
  const readOnly = mode === "read-only";
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <ThemeProvider>
          <DemoProvider readOnly={readOnly}>
            <div className="flex min-h-screen min-w-[1024px] flex-col bg-background text-foreground">
              <DemoBanner repository={REPOSITORY} />
              {mode === "judging" ? <JudgeBanner repository={REPOSITORY} /> : null}
              <div className="flex min-h-0 flex-1">
                <AppRail />
                <main className="min-w-0 flex-1">{children}</main>
              </div>
            </div>
          </DemoProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
