import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Today · Daymark",
  description: "Today's study plan: timeline, rests and one-click task links.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafaf9" },
    { media: "(prefers-color-scheme: dark)", color: "#121211" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        {children}
        <Toaster
          position="bottom-center"
          theme="system"
          offset={20}
          mobileOffset={16}
          gap={8}
          toastOptions={{
            classNames: {
              toast:
                "!rounded-xl !border !border-border !bg-foreground !text-background !shadow-lg !font-sans !gap-3 !py-3 !px-4",
              title: "!text-sm !font-medium",
              description: "!text-xs !text-background/80 !line-clamp-3",
              actionButton:
                "!h-10 !min-w-10 !rounded-md !bg-background/15 !text-background !font-medium !text-sm !px-4 hover:!bg-background/25",
            },
          }}
        />
      </body>
    </html>
  );
}
