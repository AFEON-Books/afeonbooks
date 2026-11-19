import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowLeft, CalendarDays, ChevronLeft, ChevronRight, Pencil, Plus, Trash2, X } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";

interface CalendarEvent {
  id: number;
  title: string;
  description: string;
  startsAt: string;
  endsAt: string;
  createdBy: number | null;
  creatorName: string | null;
}

interface EventForm {
  title: string;
  description: string;
  startsAt: string;
  endsAt: string;
}

const EMPTY_FORM: EventForm = { title: "", description: "", startsAt: "", endsAt: "" };

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function toLocalDateTime(date: Date): string {
  return `${localDayKey(date)}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function dayDefaultForm(day: Date): EventForm {
  const startsAt = new Date(day);
  startsAt.setHours(9, 0, 0, 0);
  const endsAt = new Date(day);
  endsAt.setHours(10, 0, 0, 0);
  return { ...EMPTY_FORM, startsAt: toLocalDateTime(startsAt), endsAt: toLocalDateTime(endsAt) };
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: string };
    return body.error || fallback;
  } catch {
    return fallback;
  }
}

export default function CalendarPage() {
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [selectedDay, setSelectedDay] = useState(() => new Date());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [currentUserId, setCurrentUserId] = useState<number | null>(null);
  const [currentUserRole, setCurrentUserRole] = useState<string | null>(null);
  const [form, setForm] = useState<EventForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const rangeStart = new Date(month.getFullYear(), month.getMonth(), 1);
    const rangeEnd = new Date(month.getFullYear(), month.getMonth() + 1, 1);
    const query = new URLSearchParams({ start: rangeStart.toISOString(), end: rangeEnd.toISOString() });
    const load = async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/calendar/events?${query}`, {
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(await readError(response, "Unable to load calendar events."));
        const result = await response.json() as {
          events: CalendarEvent[];
          currentUserId: number;
          currentUserRole: string | null;
        };
        if (!controller.signal.aborted) {
          setEvents(result.events);
          setCurrentUserId(result.currentUserId);
          setCurrentUserRole(result.currentUserRole);
          setError("");
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Unable to load calendar events.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [month, refreshKey]);

  const eventDays = useMemo(
    () => events.map((event) => new Date(event.startsAt)),
    [events],
  );
  const selectedEvents = useMemo(
    () => events.filter((event) => localDayKey(new Date(event.startsAt)) === localDayKey(selectedDay)),
    [events, selectedDay],
  );

  const openNewEvent = () => {
    setForm(dayDefaultForm(selectedDay));
    setEditingId(null);
    setError("");
  };

  const openEditEvent = (event: CalendarEvent) => {
    setForm({
      title: event.title,
      description: event.description,
      startsAt: toLocalDateTime(new Date(event.startsAt)),
      endsAt: toLocalDateTime(new Date(event.endsAt)),
    });
    setEditingId(event.id);
    setError("");
  };

  const saveEvent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(editingId === null ? "/api/calendar/events" : `/api/calendar/events/${editingId}`, {
        method: editingId === null ? "POST" : "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          startsAt: new Date(form.startsAt).toISOString(),
          endsAt: new Date(form.endsAt).toISOString(),
        }),
      });
      if (!response.ok) throw new Error(await readError(response, "Unable to save this event."));
      const result = await response.json() as { event: CalendarEvent };
      setEvents((current) => [
        ...current.filter((item) => item.id !== result.event.id),
        result.event,
      ].sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()));
      setSelectedDay(new Date(result.event.startsAt));
      setMonth(new Date(new Date(result.event.startsAt).getFullYear(), new Date(result.event.startsAt).getMonth(), 1));
      setEditingId(null);
      setForm(EMPTY_FORM);
      setRefreshKey((key) => key + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save this event.");
    } finally {
      setSaving(false);
    }
  };

  const deleteEvent = async (eventId: number) => {
    if (deletingId !== null) return;
    setDeletingId(eventId);
    setError("");
    try {
      const response = await fetch(`/api/calendar/events/${eventId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) throw new Error(await readError(response, "Unable to delete this event."));
      setEvents((current) => current.filter((event) => event.id !== eventId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to delete this event.");
    } finally {
      setDeletingId(null);
    }
  };

  const canManage = (event: CalendarEvent) => currentUserRole === "admin" || event.createdBy === currentUserId;
  const monthLabel = month.toLocaleDateString([], { month: "long", year: "numeric" });

  return (
    <main className="flex h-dvh flex-col bg-[#f7f8fa] font-sans text-[#1d1c1d]">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-black/10 bg-white px-4 sm:px-6">
        <a href="/hub" className="inline-flex items-center gap-2 text-sm font-bold text-black/60 hover:text-black">
          <ArrowLeft size={16} /> Hub
        </a>
        <span className="text-black/25">/</span>
        <h1 className="flex items-center gap-2 text-sm font-bold"><CalendarDays size={17} /> Calendar</h1>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4 sm:p-6 lg:flex-row">
        <section className="min-w-0 flex-1 rounded-xl border border-black/10 bg-white p-3 shadow-sm sm:p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-lg font-bold">{monthLabel}</h2>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => { const next = new Date(month.getFullYear(), month.getMonth() - 1, 1); setMonth(next); }} aria-label="Previous month" className="rounded-md border border-black/10 p-2 hover:bg-black/5">
                <ChevronLeft size={17} />
              </button>
              <button type="button" onClick={() => { const today = new Date(); setMonth(new Date(today.getFullYear(), today.getMonth(), 1)); setSelectedDay(today); }} className="rounded-md border border-black/10 px-3 py-2 text-xs font-semibold hover:bg-black/5">Today</button>
              <button type="button" onClick={() => { const next = new Date(month.getFullYear(), month.getMonth() + 1, 1); setMonth(next); }} aria-label="Next month" className="rounded-md border border-black/10 p-2 hover:bg-black/5">
                <ChevronRight size={17} />
              </button>
            </div>
          </div>
          <Calendar
            mode="single"
            month={month}
            onMonthChange={setMonth}
            selected={selectedDay}
            onSelect={(day) => {
              if (!day) return;
              setSelectedDay(day);
              setMonth(new Date(day.getFullYear(), day.getMonth(), 1));
            }}
            modifiers={{ hasEvents: eventDays }}
            modifiersClassNames={{ hasEvents: "font-bold underline decoration-2 decoration-[#236078]" }}
            className="mx-auto w-full max-w-[32rem] [--cell-size:2.5rem] sm:[--cell-size:3.25rem]"
          />
          <div className="mt-3 flex items-center justify-center gap-2 text-xs text-black/45">
            <span className="h-2 w-2 rounded-full bg-[#236078]" /> Days with scheduled events
          </div>
        </section>

        <aside className="flex w-full shrink-0 flex-col rounded-xl border border-black/10 bg-white shadow-sm lg:w-[24rem]">
          <div className="flex items-center justify-between border-b border-black/10 px-4 py-4">
            <div>
              <h2 className="font-bold">{selectedDay.toLocaleDateString([], { weekday: "long" })}</h2>
              <p className="mt-0.5 text-xs text-black/50">{selectedDay.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" })}</p>
            </div>
            <button type="button" onClick={openNewEvent} className="inline-flex items-center gap-1.5 rounded-md bg-[#80d7f6] px-3 py-2 text-xs font-bold text-[#111] hover:bg-[#6ac9eb]">
              <Plus size={15} /> Add event
            </button>
          </div>
          <div className="min-h-36 flex-1 space-y-3 overflow-y-auto p-4">
            {loading && <p className="py-8 text-center text-sm text-black/45">Loading events…</p>}
            {!loading && selectedEvents.length === 0 && <p className="py-8 text-center text-sm text-black/45">No events scheduled for this day.</p>}
            {selectedEvents.map((event) => (
              <article key={event.id} className="rounded-lg border border-black/10 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="break-words text-sm font-semibold">{event.title}</h3>
                    <p className="mt-1 text-xs text-black/55">
                      {new Date(event.startsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                      {" – "}
                      {new Date(event.endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                    </p>
                  </div>
                  {canManage(event) && (
                    <div className="flex shrink-0 gap-1">
                      <button type="button" onClick={() => openEditEvent(event)} aria-label={`Edit ${event.title}`} className="rounded p-1.5 text-black/45 hover:bg-black/5 hover:text-black">
                        <Pencil size={14} />
                      </button>
                      <button type="button" onClick={() => void deleteEvent(event.id)} disabled={deletingId === event.id} aria-label={`Delete ${event.title}`} className="rounded p-1.5 text-black/45 hover:bg-red-50 hover:text-red-700 disabled:opacity-40">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  )}
                </div>
                {event.description && <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-5 text-black/70">{event.description}</p>}
                <p className="mt-2 text-[10px] text-black/40">{event.creatorName ? `Added by ${event.creatorName}` : "Calendar event"}</p>
              </article>
            ))}
          </div>
        </aside>
      </div>

      {editingId !== null || form.startsAt ? (
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/40 p-4" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !saving) { setEditingId(null); setForm(EMPTY_FORM); }
        }}>
          <form onSubmit={saveEvent} className="w-full max-w-lg space-y-4 rounded-xl bg-white p-5 shadow-2xl sm:p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">{editingId === null ? "Add calendar event" : "Edit calendar event"}</h2>
              <button type="button" onClick={() => { setEditingId(null); setForm(EMPTY_FORM); }} disabled={saving} aria-label="Close event form" className="rounded p-1 hover:bg-black/5 disabled:opacity-40">
                <X size={18} />
              </button>
            </div>
            <label className="block text-sm font-medium">
              Title
              <input value={form.title} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} maxLength={120} required autoFocus className="mt-1.5 w-full rounded-md border border-black/15 px-3 py-2 text-sm outline-none focus:border-[#236078]" />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm font-medium">
                Starts
                <input type="datetime-local" value={form.startsAt} onChange={(event) => setForm((current) => ({ ...current, startsAt: event.target.value }))} required className="mt-1.5 w-full rounded-md border border-black/15 px-2 py-2 text-sm outline-none focus:border-[#236078]" />
              </label>
              <label className="block text-sm font-medium">
                Ends
                <input type="datetime-local" value={form.endsAt} onChange={(event) => setForm((current) => ({ ...current, endsAt: event.target.value }))} required className="mt-1.5 w-full rounded-md border border-black/15 px-2 py-2 text-sm outline-none focus:border-[#236078]" />
              </label>
            </div>
            <label className="block text-sm font-medium">
              Description <span className="font-normal text-black/40">(optional)</span>
              <textarea value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} maxLength={2000} rows={4} className="mt-1.5 w-full resize-y rounded-md border border-black/15 px-3 py-2 text-sm outline-none focus:border-[#236078]" />
            </label>
            {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => { setEditingId(null); setForm(EMPTY_FORM); }} disabled={saving} className="rounded-md border border-black/15 px-4 py-2 text-sm font-semibold hover:bg-black/5 disabled:opacity-40">Cancel</button>
              <button type="submit" disabled={saving} className="rounded-md bg-[#80d7f6] px-4 py-2 text-sm font-bold text-[#111] hover:bg-[#6ac9eb] disabled:opacity-40">
                {saving ? "Saving…" : editingId === null ? "Create event" : "Save changes"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
      {error && !form.startsAt && <p role="alert" className="border-t border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">{error}</p>}
    </main>
  );
}
