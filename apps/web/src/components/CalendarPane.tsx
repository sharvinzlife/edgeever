import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, ChevronLeft, ChevronRight, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { WORKSPACE_PAGE_TITLE_CLASSNAME } from "@/lib/workspace-ui";
import { AppConfirmDialog } from "./dialogs/ConfirmDialogs";
import type { EdgeEverRepository } from "@/lib/repository";
import { ExecutionCenterButton } from "@/components/execution/ExecutionCenterButton";
import {
  CALENDAR_NOTEBOOK_NAME,
  CALENDAR_TAG,
  countDateTags,
  isCalendarNavKey,
  monthGrid,
  moveDate,
  toDateTag,
} from "@/lib/calendar-dates";
import { icsEventToDraft, parseIcs, type CalendarDraft } from "@/lib/ics-import";

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const CalendarPane = ({
  onClose,
  onSelectTag,
  repository,
  onOpenExecutionCenter,
}: {
  onClose: () => void;
  onSelectTag: (tag: string) => void;
  repository: EdgeEverRepository;
  onOpenExecutionCenter: () => void;
}) => {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState(() => new Date());
  const [importDrafts, setImportDrafts] = useState<CalendarDraft[] | null>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const buttonsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const skipFocusRef = useRef(true);
  const today = new Date();

  const tagsQuery = useQuery({ queryKey: ["tags"], queryFn: () => repository.listTags() });
  const counts = countDateTags(tagsQuery.data?.tags ?? []);
  const dateTag = toDateTag(selected);
  const selectedCount = counts.get(dateTag) ?? 0;
  const grid = monthGrid(selected);
  const monthLabel = new Intl.DateTimeFormat(i18n.language, { month: "long", year: "numeric" }).format(selected);
  const selectedLabel = new Intl.DateTimeFormat(i18n.language, { dateStyle: "full" }).format(selected);
  const weekdayLabels = Array.from({ length: 7 }, (_, index) =>
    new Intl.DateTimeFormat(i18n.language, { weekday: "narrow" }).format(new Date(2024, 0, 7 + index)),
  );

  useEffect(() => {
    if (skipFocusRef.current) {
      skipFocusRef.current = false;
      return;
    }
    buttonsRef.current.get(toDateTag(selected))?.focus({ preventScroll: true });
  }, [selected]);

  const invalidateCalendarData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["tags"] }),
      queryClient.invalidateQueries({ queryKey: ["memos"] }),
      queryClient.invalidateQueries({ queryKey: ["notebooks"] }),
    ]);
  };

  const ensureCalendarNotebook = async () => {
    const { notebooks } = await repository.listNotebooks();
    const existing = notebooks.find((notebook) => notebook.name === CALENDAR_NOTEBOOK_NAME);
    if (existing) return existing.id;
    const { notebook } = await repository.createNotebook({ name: CALENDAR_NOTEBOOK_NAME });
    return notebook.id;
  };

  const addEntryMutation = useMutation({
    mutationFn: async () => {
      const notebookId = await ensureCalendarNotebook();
      return repository.createMemo({ notebookId, title: "", contentMarkdown: "", tags: [dateTag, CALENDAR_TAG] });
    },
    onSuccess: async () => {
      await invalidateCalendarData();
      onSelectTag(dateTag);
    },
    onError: (error) => setImportMessage(t("calendar.addEntryFailed", { message: errorMessage(error) })),
  });

  const handleFilePicked = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setImportMessage(null);
    try {
      const text = await file.text();
      const drafts = parseIcs(text).map(icsEventToDraft);
      if (drafts.length === 0) {
        setImportMessage(t("calendar.importNoEvents"));
        return;
      }
      setImportDrafts(drafts);
    } catch (error) {
      setImportMessage(t("calendar.importFailed", { message: errorMessage(error) }));
    }
  };

  const runImport = async () => {
    if (!importDrafts) return;
    setImporting(true);
    try {
      const notebookId = await ensureCalendarNotebook();
      let created = 0;
      let skipped = 0;
      for (const draft of importDrafts) {
        const { memos } = await repository.listMemos({ tag: draft.tags[0], limit: 200 });
        if (memos.some((memo) => memo.title === draft.title)) {
          skipped += 1;
          continue;
        }
        await repository.createMemo({ notebookId, title: draft.title, tags: draft.tags, contentMarkdown: draft.contentMarkdown });
        created += 1;
      }
      await invalidateCalendarData();
      setImportDrafts(null);
      setImportMessage(t("calendar.importResult", { created, skipped }));
    } catch (error) {
      setImportDrafts(null);
      setImportMessage(t("calendar.importFailed", { message: errorMessage(error) }));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-card">
      <header className="flex h-[calc(4rem+env(safe-area-inset-top))] shrink-0 items-end justify-between border-b border-slate-200 px-6 pb-3 pt-[env(safe-area-inset-top)] lg:h-16 lg:items-center lg:pb-0 lg:pt-0">
        <div className="flex min-w-0 items-center gap-3">
          <Button size="icon" variant="ghost" aria-label={t("common.back")} onClick={onClose} className="h-9 w-9 rounded-lg hover:bg-slate-100">
            <ChevronLeft className="h-5 w-5 text-slate-500" />
          </Button>
          <div className="min-w-0">
            <h1 className={`flex items-center gap-2 ${WORKSPACE_PAGE_TITLE_CLASSNAME}`}><CalendarDays className="h-4 w-4 text-emerald-700" />{t("calendar.title")}</h1>
            <p className="mt-0.5 text-xs text-slate-500">{monthLabel}</p>
          </div>
        </div>
        <ExecutionCenterButton onClick={onOpenExecutionCenter} />
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4 lg:px-6 lg:py-6">
        <div className="mx-auto w-full max-w-3xl">
          <div className="mb-4 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <Button size="icon" variant="ghost" aria-label={t("calendar.previousMonth")} onClick={() => setSelected(moveDate(selected, "PageUp"))}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="outline" onClick={() => setSelected(new Date())}>{t("calendar.today")}</Button>
              <Button size="icon" variant="ghost" aria-label={t("calendar.nextMonth")} onClick={() => setSelected(moveDate(selected, "PageDown"))}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            <Button size="sm" variant="outline" className="gap-2" onClick={() => fileInputRef.current?.click()}>
              <Upload className="h-4 w-4" />{t("calendar.importIcs")}
            </Button>
            <input ref={fileInputRef} type="file" accept=".ics,text/calendar" className="hidden" onChange={handleFilePicked} />
          </div>

          {importMessage ? <p className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600" role="status">{importMessage}</p> : null}

          <div
            role="grid"
            aria-label={t("calendar.gridLabel")}
            className="rounded-lg border border-slate-200 bg-card p-2"
            onKeyDown={(event) => {
              if (isCalendarNavKey(event.key)) {
                event.preventDefault();
                setSelected(moveDate(selected, event.key));
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                onSelectTag(toDateTag(selected));
              }
            }}
          >
            <div className="grid grid-cols-7">
              {weekdayLabels.map((label, index) => (
                <div key={`weekday-${index}`} className="py-1 text-center text-xs font-semibold text-slate-400">{label}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {grid.map((day) => {
                const dayTag = toDateTag(day);
                const isSelected = sameDay(day, selected);
                const inMonth = day.getMonth() === selected.getMonth();
                const isToday = sameDay(day, today);
                const count = counts.get(dayTag) ?? 0;
                return (
                  <button
                    key={dayTag}
                    ref={(element) => {
                      if (element) buttonsRef.current.set(dayTag, element);
                      else buttonsRef.current.delete(dayTag);
                    }}
                    type="button"
                    tabIndex={isSelected ? 0 : -1}
                    aria-selected={isSelected}
                    aria-label={dayTag}
                    className={cn(
                      "flex h-12 flex-col items-center justify-center rounded-md text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30",
                      inMonth ? "text-slate-800" : "text-slate-300",
                      isSelected ? "bg-emerald-600 font-semibold text-white" : "hover:bg-slate-100",
                      isToday && !isSelected && "ring-1 ring-emerald-400",
                    )}
                    onClick={() => setSelected(day)}
                    onDoubleClick={() => onSelectTag(dayTag)}
                  >
                    <span>{day.getDate()}</span>
                    {count > 0 ? (
                      <span className={cn("mt-0.5 flex items-center gap-1 text-[10px]", isSelected ? "text-white" : "text-emerald-700")}>
                        <span className="h-1 w-1 rounded-full bg-emerald-500" />
                        {count}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-slate-200 bg-card px-4 py-4">
            <p className="text-sm font-semibold text-slate-950">{selectedLabel}</p>
            <p className="mt-1 text-xs text-slate-500">
              {selectedCount > 0 ? t("calendar.entryCount", { count: selectedCount }) : t("calendar.noEntries")}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="solid" onClick={() => onSelectTag(dateTag)}>{t("calendar.openDay")}</Button>
              <Button size="sm" variant="outline" onClick={() => addEntryMutation.mutate()} disabled={addEntryMutation.isPending}>{t("calendar.addEntry")}</Button>
            </div>
          </div>
        </div>
      </main>

      {importDrafts ? (
        <AppConfirmDialog
          title={t("calendar.importConfirmTitle", { count: importDrafts.length })}
          description={t("calendar.importConfirmDescription")}
          confirmLabel={t("calendar.importConfirmLabel")}
          tone="primary"
          isWorking={importing}
          onCancel={() => setImportDrafts(null)}
          onConfirm={runImport}
        />
      ) : null}
    </div>
  );
};
