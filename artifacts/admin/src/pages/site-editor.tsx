import { useEffect, useState, type DragEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Eye,
  GripVertical,
  Monitor,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import {
  getGetContentQueryKey,
  useGetContent,
  useUpdateContent,
} from "@workspace/api-client-react";
import type { SiteContent } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

const SECTION_LABELS = {
  hero: "Hero",
  shop: "Shop",
  about: "About",
  faq: "FAQs",
} as const;

type HomeSection = keyof typeof SECTION_LABELS;
type TextField =
  | "heroTitle"
  | "heroSubtitle"
  | "ctaLabel"
  | "ctaUrl"
  | "coverImageUrl"
  | "aboutHeading"
  | "aboutBody"
  | "authorsLine"
  | "illustratorLine";

const DEFAULT_SECTION_ORDER: HomeSection[] = ["hero", "shop", "about", "faq"];

function isHomeSection(value: string): value is HomeSection {
  return Object.hasOwn(SECTION_LABELS, value);
}

function normalizeSectionOrder(
  order: string[] | undefined,
  customIds: string[],
): string[] {
  const allowed = new Set<string>([...DEFAULT_SECTION_ORDER, ...customIds]);
  const valid = [
    ...new Set((order ?? []).filter((section) => allowed.has(section))),
  ];
  return [
    ...valid,
    ...DEFAULT_SECTION_ORDER.filter((section) => !valid.includes(section)),
    ...customIds.filter((section) => !valid.includes(section)),
  ];
}

function customSectionDocument(section: {
  html: string;
  css: string;
  js: string;
}): string {
  const css = section.css.replace(/<\/style/gi, "<\\/style");
  const js = section.js.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data:; font-src https: data:; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'"><style>html,body{margin:0;min-height:100%;font-family:system-ui,sans-serif}*{box-sizing:border-box}${css}</style></head><body>${section.html}<script>${js}</script></body></html>`;
}

function CanvasSection({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
      className={`relative block w-full cursor-pointer text-left transition-shadow ${selected ? "z-10 ring-2 ring-blue-600 ring-offset-2" : "hover:ring-1 hover:ring-blue-400"}`}
    >
      {children}
    </div>
  );
}

export default function SiteEditor() {
  const queryClient = useQueryClient();
  const { data: content, isLoading, isError } = useGetContent();
  const updateContent = useUpdateContent();
  const [draft, setDraft] = useState<SiteContent | null>(null);
  const [selectedSection, setSelectedSection] = useState<string>("hero");
  const [draggedSection, setDraggedSection] = useState<string | null>(null);

  useEffect(() => {
    if (content) {
      setDraft({
        ...content,
        homeSectionOrder: normalizeSectionOrder(
          content.homeSectionOrder,
          content.homeCustomSections.map((section) => section.id),
        ),
      });
    }
  }, [content]);

  const setText = (key: TextField, value: string) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  };

  const moveSection = (from: string, to: string) => {
    setDraft((current) => {
      if (!current) return current;
      const order = [...current.homeSectionOrder];
      const fromIndex = order.indexOf(from);
      const toIndex = order.indexOf(to);
      if (fromIndex < 0 || toIndex < 0) return current;
      order.splice(fromIndex, 1);
      order.splice(toIndex, 0, from);
      return { ...current, homeSectionOrder: order };
    });
  };

  const publish = () => {
    if (!draft) return;
    updateContent.mutate(
      {
        data: {
          ...draft,
          homeSectionOrder: normalizeSectionOrder(
            draft.homeSectionOrder,
            draft.homeCustomSections.map((section) => section.id),
          ),
        },
      },
      {
        onSuccess: (saved) => {
          setDraft(saved);
          queryClient.setQueryData(getGetContentQueryKey(), saved);
          toast.success("Site changes published");
        },
        onError: (error) =>
          toast.error(
            error instanceof Error
              ? error.message
              : "Unable to publish site changes",
          ),
      },
    );
  };

  const addCustomSection = () => {
    const section = {
      id: `custom-${crypto.randomUUID()}`,
      name: "Custom code",
      html: '<div class="custom-widget">Your custom section</div>',
      css: ".custom-widget{padding:48px 24px;text-align:center;background:#f3f4f6;font-size:24px;font-weight:700}",
      js: "",
    };
    setDraft((current) =>
      current
        ? {
            ...current,
            homeCustomSections: [...current.homeCustomSections, section],
            homeSectionOrder: [...current.homeSectionOrder, section.id],
          }
        : current,
    );
    setSelectedSection(section.id);
  };

  const removeCustomSection = (id: string) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            homeCustomSections: current.homeCustomSections.filter(
              (section) => section.id !== id,
            ),
            homeSectionOrder: current.homeSectionOrder.filter(
              (section) => section !== id,
            ),
          }
        : current,
    );
    setSelectedSection("hero");
  };

  const setCustomSection = (
    id: string,
    key: "name" | "html" | "css" | "js",
    value: string,
  ) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            homeCustomSections: current.homeCustomSections.map((section) =>
              section.id === id ? { ...section, [key]: value } : section,
            ),
          }
        : current,
    );
  };

  if (isError) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f3f4f6] text-sm text-red-700">
        Unable to load site content.
      </main>
    );
  }
  if (isLoading || !draft) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f3f4f6] text-sm text-black/60">
        Loading site editor…
      </main>
    );
  }

  const renderPreviewSection = (section: string) => {
    const selected = selectedSection === section;
    const select = () => setSelectedSection(section);
    if (section === "hero") {
      return (
        <CanvasSection key={section} selected={selected} onClick={select}>
          <section className="flex min-h-[420px] items-center bg-[#faf7f2] px-8 py-14 md:px-16">
            <div className="grid w-full items-center gap-8 md:grid-cols-2">
              <div>
                <p className="mb-3 text-xs font-bold uppercase tracking-[.2em] text-black/45">
                  Hero section
                </p>
                <h1 className="text-4xl font-bold leading-tight tracking-tight md:text-5xl">
                  {draft.heroTitle}
                </h1>
                <p className="mt-4 text-black/60">{draft.heroSubtitle}</p>
                <span className="mt-7 inline-flex rounded-full border border-black bg-white px-7 py-3 text-sm">
                  {draft.ctaLabel}
                </span>
              </div>
              {draft.coverImageUrl && (
                <img
                  src={draft.coverImageUrl}
                  alt="Book cover preview"
                  className="mx-auto max-h-80 max-w-full object-contain"
                />
              )}
            </div>
          </section>
        </CanvasSection>
      );
    }
    if (section === "shop") {
      return (
        <CanvasSection key={section} selected={selected} onClick={select}>
          <section className="bg-white px-8 py-14 text-center">
            <p className="mb-2 text-xs font-bold uppercase tracking-[.2em] text-black/45">
              Shop section
            </p>
            <h2 className="text-3xl font-bold">Shop</h2>
            <div className="mx-auto mt-8 grid max-w-3xl grid-cols-3 gap-4">
              {[1, 2, 3].map((item) => (
                <div
                  key={item}
                  className="aspect-[3/4] rounded-sm bg-[#f2f0ec]"
                />
              ))}
            </div>
            <p className="mt-4 text-xs text-black/45">
              Products are managed in Main Admin.
            </p>
          </section>
        </CanvasSection>
      );
    }
    if (section === "about") {
      return (
        <CanvasSection key={section} selected={selected} onClick={select}>
          <section className="bg-[#faf7f2] px-8 py-14 text-center">
            <p className="mb-2 text-xs font-bold uppercase tracking-[.2em] text-black/45">
              About section
            </p>
            <h2 className="text-3xl font-bold">{draft.aboutHeading}</h2>
            <p className="mx-auto mt-5 max-w-2xl whitespace-pre-wrap leading-relaxed text-black/65">
              {draft.aboutBody}
            </p>
            <p className="mt-8 text-xs font-bold uppercase tracking-widest text-black/50">
              By {draft.authorsLine} · Illustrated by {draft.illustratorLine}
            </p>
          </section>
        </CanvasSection>
      );
    }
    if (section === "faq") {
      return (
        <CanvasSection key={section} selected={selected} onClick={select}>
          <section className="bg-white px-8 py-14">
            <p className="mb-2 text-center text-xs font-bold uppercase tracking-[.2em] text-black/45">
              FAQ section
            </p>
            <h2 className="mb-6 text-center text-3xl font-bold">
              Frequently Asked Questions
            </h2>
            <div className="mx-auto max-w-2xl divide-y divide-black/10 border-y border-black/10">
              {draft.faqs.slice(0, 3).map((faq, index) => (
                <div key={`${faq.question}-${index}`} className="py-4">
                  <p className="font-semibold">{faq.question}</p>
                  <p className="mt-2 text-sm text-black/60">{faq.answer}</p>
                </div>
              ))}
            </div>
          </section>
        </CanvasSection>
      );
    }

    const customSection = draft.homeCustomSections.find(
      (item) => item.id === section,
    );
    if (!customSection) return null;
    return (
      <CanvasSection key={section} selected={selected} onClick={select}>
        <div className="bg-white p-3">
          <p className="mb-2 text-xs font-bold uppercase tracking-[.2em] text-black/45">
            {customSection.name}
          </p>
          <iframe
            title={`${customSection.name} preview`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            srcDoc={customSectionDocument(customSection)}
            className="h-[320px] w-full border border-dashed border-slate-300"
          />
        </div>
      </CanvasSection>
    );
  };

  const textField = (label: string, key: TextField, multiline = false) => (
    <label key={key} className="block space-y-1.5">
      <span className="text-xs font-semibold text-slate-600">{label}</span>
      {multiline ? (
        <Textarea
          value={draft[key]}
          onChange={(event) => setText(key, event.target.value)}
          rows={5}
          className="resize-y bg-white"
        />
      ) : (
        <Input
          value={draft[key]}
          onChange={(event) => setText(key, event.target.value)}
          className="bg-white"
        />
      )}
    </label>
  );

  const handleDrop = (event: DragEvent<HTMLElement>, target: string) => {
    event.preventDefault();
    if (draggedSection && draggedSection !== target)
      moveSection(draggedSection, target);
    setDraggedSection(null);
  };

  return (
    <main className="flex min-h-screen flex-col bg-[#e9edf2] text-slate-900">
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-5">
        <div className="flex items-center gap-3">
          <a
            href="/"
            aria-label="Admin hub"
            className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 hover:bg-slate-50"
          >
            <ArrowLeft size={17} />
          </a>
          <div>
            <p className="text-sm font-bold">Site Editor</p>
            <p className="text-[11px] text-slate-500">
              AFEON Books · Home page
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden items-center gap-1.5 text-xs text-slate-500 sm:flex">
            <Eye size={14} /> Changes preview live
          </span>
          <Button
            type="button"
            onClick={publish}
            disabled={updateContent.isPending}
            className="gap-2 bg-blue-700 text-white hover:bg-blue-800"
          >
            <Save size={15} />
            {updateContent.isPending ? "Publishing…" : "Publish"}
          </Button>
        </div>
      </header>

      <div className="grid flex-1 lg:grid-cols-[250px_minmax(0,1fr)_290px]">
        <aside className="border-b border-slate-200 bg-white p-4 lg:border-b-0 lg:border-r">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-widest text-slate-500">
              Page sections
            </h2>
            <Monitor size={15} className="text-slate-400" />
          </div>
          <p className="mb-4 text-xs leading-relaxed text-slate-500">
            Drag sections to rearrange the homepage. Select a section to edit
            it.
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={addCustomSection}
            disabled={draft.homeCustomSections.length >= 10}
            className="mb-4 w-full justify-start gap-2"
          >
            <Plus size={15} /> Add custom code
          </Button>
          <div className="space-y-2">
            {draft.homeSectionOrder.map((section, index) => {
              const customSection = draft.homeCustomSections.find(
                (item) => item.id === section,
              );
              const label =
                customSection?.name ??
                (isHomeSection(section) ? SECTION_LABELS[section] : section);
              return (
                <div
                  key={section}
                  draggable
                  onDragStart={() => setDraggedSection(section)}
                  onDragEnd={() => setDraggedSection(null)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => handleDrop(event, section)}
                  className={`flex items-center gap-2 rounded-lg border px-2 py-2 ${selectedSection === section ? "border-blue-500 bg-blue-50" : "border-slate-200 bg-white"} ${draggedSection === section ? "opacity-50" : ""}`}
                >
                  <GripVertical
                    size={16}
                    className="cursor-grab text-slate-400"
                  />
                  <button
                    type="button"
                    onClick={() => setSelectedSection(section)}
                    className="flex-1 truncate text-left text-sm font-medium"
                  >
                    {label}
                  </button>
                  {customSection && (
                    <button
                      type="button"
                      aria-label={`Delete ${label}`}
                      onClick={() => removeCustomSection(section)}
                      className="rounded p-1 text-slate-500 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`Move ${label} up`}
                    disabled={index === 0}
                    onClick={() =>
                      moveSection(section, draft.homeSectionOrder[index - 1]!)
                    }
                    className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30"
                  >
                    <ArrowUp size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${label} down`}
                    disabled={index === draft.homeSectionOrder.length - 1}
                    onClick={() =>
                      moveSection(section, draft.homeSectionOrder[index + 1]!)
                    }
                    className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30"
                  >
                    <ArrowDown size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        </aside>

        <section
          className="min-w-0 overflow-auto p-4 md:p-8"
          aria-label="Live page preview"
        >
          <div className="mx-auto max-w-[920px] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
            <div className="flex h-10 items-center gap-2 border-b border-slate-200 bg-slate-50 px-4">
              <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
              <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
              <span className="h-2.5 w-2.5 rounded-full bg-green-400" />
              <span className="ml-3 truncate rounded bg-white px-3 py-1 text-[10px] text-slate-500">
                afeonbooks.com
              </span>
            </div>
            <div className="bg-[#faf7f2]">
              <div className="border-b border-black/5 px-7 py-4 text-sm font-bold">
                {draft.brandName}
                <span className="float-right text-xs font-normal text-black/50">
                  Home　 Shop　 Blog　 FAQ
                </span>
              </div>
              {draft.homeSectionOrder.map(renderPreviewSection)}
              <div className="bg-[#faf7f2] px-6 py-5 text-center text-xs text-black/45">
                {draft.footerNote}
              </div>
            </div>
          </div>
        </section>

        <aside className="border-t border-slate-200 bg-white p-5 lg:border-l lg:border-t-0">
          <h2 className="mb-1 text-xs font-bold uppercase tracking-widest text-slate-500">
            Section settings
          </h2>
          {(() => {
            const selectedCustom = draft.homeCustomSections.find(
              (section) => section.id === selectedSection,
            );
            const label =
              selectedCustom?.name ??
              (isHomeSection(selectedSection)
                ? SECTION_LABELS[selectedSection]
                : selectedSection);
            return <p className="mb-5 text-lg font-bold">{label}</p>;
          })()}
          <div className="space-y-4">
            {selectedSection === "hero" && (
              <>
                {textField("Heading", "heroTitle")}
                {textField("Description", "heroSubtitle")}
                {textField("Button label", "ctaLabel")}
                {textField("Button link", "ctaUrl")}
                {textField("Image URL", "coverImageUrl")}
              </>
            )}
            {selectedSection === "about" && (
              <>
                {textField("Heading", "aboutHeading")}
                {textField("Body text", "aboutBody", true)}
                {textField("Authors", "authorsLine")}
                {textField("Illustrator", "illustratorLine")}
              </>
            )}
            {selectedSection === "shop" && (
              <p className="text-sm leading-relaxed text-slate-600">
                Products and their order are managed in Main Admin. Drag this
                section in the list to change where it appears on the homepage.
              </p>
            )}
            {selectedSection === "faq" && (
              <div className="space-y-4">
                <p className="text-sm leading-relaxed text-slate-600">
                  Edit questions and answers in Main Admin → Site Content. Drag
                  this section to change its position.
                </p>
                {draft.faqs.map((faq, index) => (
                  <div
                    key={`${faq.question}-${index}`}
                    className="rounded-lg border border-slate-200 p-3"
                  >
                    <p className="line-clamp-2 text-xs font-semibold">
                      {faq.question}
                    </p>
                    <p className="mt-1 line-clamp-2 text-xs text-slate-500">
                      {faq.answer}
                    </p>
                  </div>
                ))}
              </div>
            )}
            {draft.homeCustomSections.some(
              (section) => section.id === selectedSection,
            ) &&
              (() => {
                const section = draft.homeCustomSections.find(
                  (item) => item.id === selectedSection,
                )!;
                return (
                  <>
                    <label className="block space-y-1.5">
                      <span className="text-xs font-semibold text-slate-600">
                        Section name
                      </span>
                      <Input
                        value={section.name}
                        onChange={(event) =>
                          setCustomSection(
                            section.id,
                            "name",
                            event.target.value,
                          )
                        }
                        maxLength={80}
                        className="bg-white"
                      />
                    </label>
                    {(["html", "css", "js"] as const).map((field) => (
                      <label key={field} className="block space-y-1.5">
                        <span className="text-xs font-semibold uppercase text-slate-600">
                          {field}
                        </span>
                        <Textarea
                          value={section[field]}
                          onChange={(event) =>
                            setCustomSection(
                              section.id,
                              field,
                              event.target.value,
                            )
                          }
                          maxLength={20000}
                          rows={field === "html" ? 9 : 7}
                          spellCheck={false}
                          className="resize-y bg-slate-950 font-mono text-xs text-slate-100"
                        />
                      </label>
                    ))}
                    <p className="text-xs leading-relaxed text-slate-500">
                      Code runs in a sandboxed frame. It cannot access the store
                      page, customer session, or network APIs.
                    </p>
                  </>
                );
              })()}
          </div>
        </aside>
      </div>
    </main>
  );
}
