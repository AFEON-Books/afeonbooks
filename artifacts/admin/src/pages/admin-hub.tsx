import {
  Activity,
  ArrowUpRight,
  BookOpen,
  Cloud,
  Code2,
  Database,
  Github,
  LayoutDashboard,
  Mail,
  MessageCircle,
  PenTool,
  Server,
  ShoppingCart,
  type LucideIcon,
} from "lucide-react";
import xlogo from "@assets/logo_web.png";

const tools: Array<{
  name: string;
  description: string;
  href: string;
  icon: LucideIcon;
  external?: boolean;
}> = [
  {
    name: "Main Admin",
    description: "Manage orders, products, users, and store settings.",
    href: "/main-admin#orders",
    icon: LayoutDashboard,
  },
  {
    name: "Site Editor",
    description: "Edit website content and storefront settings.",
    href: "/site-editor#site-editor",
    icon: PenTool,
  },
  {
    name: "POS Checkout",
    description: "Process in-person orders and payments.",
    href: "/pos",
    icon: ShoppingCart,
  },
  {
    name: "Zoho Mail",
    description: "Open the staff mailbox and email tools.",
    href: "/zoho-mail",
    icon: Mail,
  },
  {
    name: "Team Chat",
    description: "Message staff and check who is online.",
    href: "/chat",
    icon: MessageCircle,
  },
  {
    name: "GitHub",
    description: "Repository and source control.",
    href: "https://github.com/acdu1/afeonbooks",
    icon: Github,
    external: true,
  },
  {
    name: "GitHub Codespaces",
    description: "Open the online development workspace.",
    href: "https://ubiquitous-guacamole-x545p5p7996439pxj.github.dev/",
    icon: Code2,
    external: true,
  },
  {
    name: "Cloudflare",
    description: "Worker, DNS, and domain settings.",
    href: "https://dash.cloudflare.com/a130548b1748b2365a5c0e027fe3ebd8/home",
    icon: Cloud,
    external: true,
  },
  {
    name: "Supabase",
    description: "Database and project storage.",
    href: "https://supabase.com/dashboard/project/msxfhfdeqxqvjuypcspm",
    icon: Database,
    external: true,
  },
  {
    name: "Render",
    description: "API service and deployment settings.",
    href: "https://dashboard.render.com/web/srv-da57c6jbc2fs738388lg",
    icon: Server,
    external: true,
  },
  {
    name: "StatusPage",
    description: "Service status and incident updates.",
    href: "https://status.afeonbooks.com/",
    icon: Activity,
    external: true,
  },
  {
    name: "Reedsy Book Editor",
    description: "Open the book editing workspace.",
    href: "https://editor.reedsy.com/",
    icon: BookOpen,
    external: true,
  },
];

function ToolCard({
  tool,
}: {
  tool: (typeof tools)[number];
}) {
  const Icon = tool.icon;
  return (
    <a
      href={tool.href}
      {...(tool.external
        ? { target: "_blank", rel: "noopener noreferrer" }
        : {})}
      className="group flex min-h-40 flex-col border border-black/10 bg-white p-5 transition duration-200 hover:-translate-y-0.5 hover:border-black/30 hover:shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black sm:p-6"
    >
      <div className="flex items-start justify-between">
        <span className="flex h-11 w-11 items-center justify-center bg-[#FAF7F2] text-black transition-colors group-hover:bg-black group-hover:text-white">
          <Icon aria-hidden="true" size={20} strokeWidth={1.7} />
        </span>
        <ArrowUpRight
          aria-hidden="true"
          size={18}
          className="text-black/35 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-black"
        />
      </div>
      <span className="mt-6 text-base font-bold tracking-tight">
        {tool.name}
      </span>
      <span className="mt-1 text-sm leading-5 text-black/55">
        {tool.description}
      </span>
    </a>
  );
}

export default function AdminHub() {
  return (
    <div className="min-h-screen bg-[#FAF7F2] font-sans text-black">
      <header className="border-b border-black/10 bg-white/70">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-6 px-5 py-5 sm:px-8">
          <a href="/" aria-label="AFEON Books Admin Hub">
            <img
              src={xlogo}
              alt=""
              className="h-10 w-36 object-contain object-left"
              draggable={false}
            />
          </a>
          <a
            href="https://afeonbooks.com/"
            className="border border-black/20 px-4 py-2.5 text-xs font-bold uppercase tracking-widest transition-colors hover:bg-black hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
          >
            View Site
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-5 pb-16 pt-12 sm:px-8 sm:pt-16 lg:pt-20">
        <section className="mb-12 max-w-3xl sm:mb-16">
          <p className="text-xs font-bold uppercase tracking-[0.24em] text-black/45">
            AFEON Books / Staff workspace
          </p>
          <h1 className="mt-4 text-5xl font-bold leading-[1.05] tracking-tight sm:text-6xl">
            Admin Hub
          </h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-black/60 sm:text-lg">
            Your tools for running the store, shaping the website, and keeping
            the team connected.
          </p>
        </section>

        <section aria-labelledby="workspace-tools">
          <div className="mb-5 flex items-center justify-between border-b border-black/15 pb-3">
            <h2
              id="workspace-tools"
              className="text-xs font-bold uppercase tracking-[0.2em]"
            >
              Store &amp; team
            </h2>
            <span className="text-xs text-black/40">01 — 05</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {tools.slice(0, 5).map((tool) => (
              <ToolCard key={tool.name} tool={tool} />
            ))}
          </div>
        </section>

        <section aria-labelledby="operations-tools" className="mt-12 sm:mt-16">
          <div className="mb-5 flex items-center justify-between border-b border-black/15 pb-3">
            <h2
              id="operations-tools"
              className="text-xs font-bold uppercase tracking-[0.2em]"
            >
              Operations &amp; services
            </h2>
            <span className="text-xs text-black/40">06 — 12</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {tools.slice(5).map((tool) => (
              <ToolCard key={tool.name} tool={tool} />
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
