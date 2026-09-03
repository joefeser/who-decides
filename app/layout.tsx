import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'who decides?',
  description: 'A Strands agent that works in the background and surfaces only when there is a real human decision.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        {children}
      </body>
    </html>
  )
}
