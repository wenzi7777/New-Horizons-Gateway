// App Studio (the Desktop's SdkPage): projects on the left, the editor (.nhs
// with the nhs language, or JSON) in the middle, Build / Emulator / Reference
// on the right. Projects are files under <dataFolder>/apps/<project>/, saved
// by the main process shortly after each edit; sources open through a file
// dialog and the App Library, and leave through Export or Install.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { BookOpen, Cpu, FilePlus2, FolderOpen, FolderSearch, Library, Sparkles, Trash2, UserRound, X } from 'lucide-react';

import { Notice, useConfirm, TextInput } from '../../../components/ui';
import { useStudio } from '../../../state/studio';
import { appsApi, errorCode } from '../api';
import { localised, type AppCatalogEntry } from '../lib/appLibrary';
import { AUTO_FILLED_AUTHORS, loadStudioAuthor, saveStudioAuthor } from '../lib/sdkAuthor';
import {
  appIdOf,
  deviceTargets,
  flowTemplate,
  freshAppId,
  isViewKind,
  kindOfFile,
  loadTargetKey,
  loadVirtualDevice,
  newProject,
  normalizeAuthor,
  panelTemplate,
  readManifestFields,
  readoutTemplate,
  saveTargetKey,
  saveVirtualDevice,
  sourceFilename,
  viewKindOfSource,
  virtualTarget,
  writeManifestField,
  type MatrixTarget,
  type SdkKind,
  type SdkProject,
} from '../lib/sdkProject';
import { analyzeFlow, analyzePanel, analyzeReadout, type Analysis } from '../sdk/lib/index.mjs';
import { useAppsT } from '../strings';
import { AiPromptDialog } from './AiPromptDialog';
import { BuildPanel } from './BuildPanel';
import { CodeEditor, type CodeEditorHandle } from './CodeEditor';
import { EmulatorPanel } from './EmulatorPanel';
import { ReferencePanel } from './ReferencePanel';

type Tab = 'build' | 'emulator' | 'reference';

const ANALYZE_DELAY_MS = 150;
const SAVE_DELAY_MS = 400;
const AUTHORING_GUIDE = 'https://github.com/wenzi7777/NHOS-App-Library/blob/main/docs/authoring.md';

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function analyze(project: SdkProject, cellCount: number): Analysis {
  if (project.kind === 'flow') return analyzeFlow(project.source, { cellCount });
  return project.kind === 'panel' ? analyzePanel(project.source) : analyzeReadout(project.source);
}

function templateFor(kind: SdkKind): (appId: string, author: string) => string {
  return kind === 'flow' ? flowTemplate : kind === 'panel' ? panelTemplate : readoutTemplate;
}

const KIND_LABEL: Record<SdkKind, string> = { flow: '.nhs', readout: 'readout', panel: 'panel' };

export default function StudioPage({ projectId, go }: { projectId: string | null; go: (path: string[]) => void }) {
  const t = useAppsT();
  const { api, snapshot } = useStudio();
  const client = useMemo(() => appsApi(api), [api]);
  const [studioAuthor, setStudioAuthor] = useState(loadStudioAuthor);
  const [editingAuthor, setEditingAuthor] = useState(() => loadStudioAuthor() === '');
  const author = studioAuthor || 'author';
  const editorRef = useRef<CodeEditorHandle | null>(null);
  const [confirmElement, confirm] = useConfirm();

  const [projects, setProjects] = useState<SdkProject[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [openError, setOpenError] = useState('');
  const [tab, setTab] = useState<Tab>('build');
  const [targetKey, setTargetKey] = useState(loadTargetKey);
  const [virtual, setVirtual] = useState(loadVirtualDevice);
  const [picking, setPicking] = useState(false);
  const [prompting, setPrompting] = useState(false);
  const [aiRequest, setAiRequest] = useState('');
  const [markedLines, setMarkedLines] = useState<Set<number>>(() => new Set());
  const markLines = useCallback((lines: Set<number>) => setMarkedLines((current) => (current.size === 0 && lines.size === 0 ? current : lines)), []);

  // Load the projects folder once; an empty folder starts with one flow app.
  useEffect(() => {
    let cancelled = false;
    client
      .listProjects()
      .then((list) => {
        if (cancelled) return;
        setProjects(list.length ? list : [newProject('flow', flowTemplate('my_app', loadStudioAuthor() || 'author'))]);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(errorCode(error));
        setProjects([newProject('flow', flowTemplate('my_app', loadStudioAuthor() || 'author'))]);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  // Save what changed, a moment after the last edit.
  const saved = useRef(new Map<string, SdkProject>());
  const toSave = useDebounced(projects, SAVE_DELAY_MS);
  useEffect(() => {
    if (!toSave) return;
    for (const project of toSave) {
      if (saved.current.get(project.id) === project) continue;
      saved.current.set(project.id, project);
      client.saveProject(project).then(
        () => setSaveError(''),
        (error: unknown) => setSaveError(errorCode(error)),
      );
    }
  }, [toSave, client]);

  useEffect(() => saveVirtualDevice(virtual), [virtual]);
  const selectTarget = useCallback((key: string) => {
    setTargetKey(key);
    saveTargetKey(key);
  }, []);

  const list = projects ?? [];
  const active = list.find((project) => project.id === projectId) ?? list[0] ?? null;
  const setActive = (id: string) => go(['studio', id]);

  const targets = useMemo(() => deviceTargets(snapshot?.devices ?? []), [snapshot?.devices]);
  const found = targets.find((item) => item.key === targetKey) ?? (targetKey === '' && targets[0] ? targets[0] : virtualTarget(virtual, t('sdkEmuVirtual')));
  const target = useMemo<MatrixTarget>(
    () => ({ key: found.key, rows: found.rows, cols: found.cols, label: found.label, firmware: found.firmware, board: found.board }),
    [found.key, found.rows, found.cols, found.label, found.firmware, found.board],
  );
  const cellCount = target.rows * target.cols;

  const pending = useDebounced(active, ANALYZE_DELAY_MS);
  const analysis = useMemo(() => (pending ? analyze(pending, cellCount) : null), [pending, cellCount]);
  const lastGoodReport = useRef<Analysis['report']>(null);
  if (analysis?.report) lastGoodReport.current = analysis.report;

  const updateSource = useCallback(
    (source: string) => {
      if (!active) return;
      setProjects((current) =>
        (current ?? []).map((project) =>
          project.id === active.id ? { ...project, source, kind: isViewKind(project.kind) ? viewKindOfSource(source) ?? project.kind : project.kind, updatedAt: Date.now() } : project,
        ),
      );
    },
    [active],
  );

  const saveAuthor = (next: string) => {
    saveStudioAuthor(next);
    setStudioAuthor(next);
    setEditingAuthor(false);
    // Apps still carrying an author the Studio filled in by itself take the real name.
    setProjects((current) =>
      (current ?? []).map((project) => {
        if (!AUTO_FILLED_AUTHORS.has(readManifestFields(project).author)) return project;
        const source = writeManifestField(project, 'author', next);
        return source === project.source ? project : { ...project, source, updatedAt: Date.now() };
      }),
    );
  };

  const addProject = (project: SdkProject) => {
    setProjects((current) => [project, ...(current ?? [])]);
    setActive(project.id);
    setTab('build');
  };
  const createProject = (kind: SdkKind) => addProject(newProject(kind, templateFor(kind)(freshAppId(list, kind === 'flow' ? 'my_app' : `my_${kind}`), author)));

  const openFile = async () => {
    setOpenError('');
    try {
      const file = await client.openSourceFile();
      if (!file) return;
      const kind = kindOfFile(file.name, file.text);
      if (!kind) setOpenError(t('sdkOpenUnsupported', { name: file.name }));
      else addProject(newProject(kind, file.text));
    } catch (error) {
      setOpenError(errorCode(error));
    }
  };

  const openFromLibrary = async (entry: AppCatalogEntry) => {
    const source = await client.librarySource(entry.id);
    addProject(newProject(source.kind, source.source, { appId: source.id, version: source.version, packageSha256: source.package_sha256 }));
    setPicking(false);
  };

  const deleteProject = async (project: SdkProject) => {
    const ok = await confirm({ title: t('sdkDeleteProject'), message: t('sdkDeleteProjectConfirm', { name: appIdOf(project) || t('sdkUntitled') }), confirmLabel: t('delete'), danger: true });
    if (!ok) return;
    try {
      await client.deleteProject(project.id);
    } catch (error) {
      setSaveError(errorCode(error));
      return;
    }
    saved.current.delete(project.id);
    setProjects((current) => {
      const remaining = (current ?? []).filter((item) => item.id !== project.id);
      return remaining.length ? remaining : [newProject('flow', flowTemplate('my_app', author))];
    });
    go(['studio']);
  };

  if (!projects || !active || !analysis) return <p className="empty">{t('loading')}</p>;

  const promptAnalysis = prompting ? (pending?.id === active.id && pending.source === active.source ? analysis : analyze(active, cellCount)) : null;
  const untouchedTemplate = active.source.trim() === '' || active.source === templateFor(active.kind)(appIdOf(active), author);
  const errorCount = analysis.diagnostics.filter((d) => d.severity === 'error').length;
  const current = pending?.id === active.id && pending.source === active.source;
  const tabs: { id: Tab; label: string }[] = [
    { id: 'build', label: t('sdkTabBuild') },
    { id: 'emulator', label: t('sdkTabEmulator') },
    { id: 'reference', label: t('sdkTabReference') },
  ];

  return (
    <div className="stack apps-studio">
      <header className="apps-header">
        <div>
          <h1>{t('sdkTitle')}</h1>
          <p className="muted">{t('sdkSubtitle')}</p>
        </div>
        <div className="apps-header-actions">
          <button type="button" className="button" onClick={() => createProject('flow')}>
            <FilePlus2 size={14} aria-hidden="true" />
            {t('sdkNewFlow')}
          </button>
          <button type="button" className="button" onClick={() => createProject('readout')}>
            <FilePlus2 size={14} aria-hidden="true" />
            {t('sdkNewReadout')}
          </button>
          <button type="button" className="button" onClick={() => createProject('panel')} title={t('sdkNewPanelHint')}>
            <FilePlus2 size={14} aria-hidden="true" />
            {t('sdkNewPanel')}
          </button>
          <button type="button" className="button" onClick={() => void openFile()}>
            <FolderOpen size={14} aria-hidden="true" />
            {t('sdkOpenFile')}
          </button>
          <button type="button" className="button" onClick={() => setPicking(true)}>
            <Library size={14} aria-hidden="true" />
            {t('sdkOpenFromLibrary')}
          </button>
          <button type="button" className="button" onClick={() => setPrompting(true)}>
            <Sparkles size={14} aria-hidden="true" />
            {t('sdkAiPrompt')}
          </button>
          <button type="button" className="button" title={t('sdkAuthorTitle')} onClick={() => setEditingAuthor(true)}>
            <UserRound size={14} aria-hidden="true" />
            {studioAuthor || t('sdkAuthorUnset')}
          </button>
          <button type="button" className="button ghost" onClick={() => void api.openExternal(AUTHORING_GUIDE)}>
            <BookOpen size={14} aria-hidden="true" />
            {t('sdkAuthoringGuide')}
          </button>
        </div>
      </header>

      {loadError ? <Notice kind="error">{t('appsProjectsLoadFailed')}: {loadError}</Notice> : null}
      {saveError ? <Notice kind="warning">{t('appsProjectsSaveFailed')}: {saveError}</Notice> : null}
      {openError ? <Notice kind="error">{openError}</Notice> : null}

      <div className="apps-workspace">
        <aside className="apps-projects" aria-label={t('sdkProjects')}>
          <h2 className="section-title">{t('sdkProjects')}</h2>
          <ul>
            {list.map((project) => {
              const selected = project.id === active.id;
              return (
                <li key={project.id} className={selected ? 'active' : undefined}>
                  <button type="button" className="apps-project" onClick={() => setActive(project.id)} aria-current={selected ? 'true' : undefined}>
                    <span className="mono">{appIdOf(project) || t('sdkUntitled')}</span>
                    <span className="muted">
                      {KIND_LABEL[project.kind]}
                      {project.origin ? ` · ${t('sdkFromLibrary')}` : ''}
                    </span>
                  </button>
                  <button type="button" className="button ghost icon-button" onClick={() => void client.revealProject(project.id)} aria-label={t('appsRevealProject')} title={t('appsRevealProject')}>
                    <FolderSearch size={13} aria-hidden="true" />
                  </button>
                  <button type="button" className="button ghost icon-button" onClick={() => void deleteProject(project)} aria-label={t('sdkDeleteProject')} title={t('sdkDeleteProject')}>
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="muted apps-small">{t('appsProjectsNote')}</p>
        </aside>

        <section className="apps-editor" aria-label={t('sdkEditor')}>
          <div className="apps-editor-toolbar">
            <span className={`apps-status-dot ${analysis.ok ? 'ok' : 'fail'}`} aria-hidden="true" />
            <strong className="mono">{sourceFilename(active.kind)}</strong>
            <span className="muted" role="status">
              {analysis.ok ? t('sdkStatusOk') : t('sdkStatusErrors', { count: errorCount })}
            </span>
            <button type="button" className="button ghost tiny apps-target" onClick={() => setTab('emulator')} title={t('sdkTargetHint')}>
              <Cpu size={13} aria-hidden="true" />
              {t('sdkTarget')} <strong>{target.label}</strong>
            </button>
          </div>
          <CodeEditor
            ref={editorRef}
            docKey={active.id}
            value={active.source}
            language={active.kind === 'flow' ? 'nhs' : 'json'}
            diagnostics={current ? analysis.diagnostics : []}
            symbols={lastGoodReport.current}
            markedLines={tab === 'emulator' ? markedLines : undefined}
            onChange={updateSource}
            ariaLabel={t('sdkEditor')}
          />
        </section>

        <section className="apps-side" aria-label={t('sdkInspector')}>
          <div className="segmented-control" role="tablist" aria-label={t('sdkInspector')} style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
            {tabs.map((item) => (
              <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : undefined} onClick={() => setTab(item.id)}>
                {item.label}
              </button>
            ))}
          </div>
          {tab === 'build' ? <BuildPanel project={active} analysis={analysis} target={target} onRevealLine={(line) => editorRef.current?.revealLine(line)} onSourceChange={updateSource} go={go} /> : null}
          {tab === 'emulator' ? <EmulatorPanel key={active.id} analysis={analysis} target={target} targets={targets} virtual={virtual} onVirtualChange={setVirtual} onSelectTarget={selectTarget} onMarkLines={markLines} /> : null}
          {tab === 'reference' ? <ReferencePanel kind={active.kind} /> : null}
        </section>
      </div>

      {picking ? <LibraryPicker onOpen={openFromLibrary} onClose={() => setPicking(false)} /> : null}
      {editingAuthor ? <AuthorDialog current={studioAuthor} onSave={saveAuthor} onClose={studioAuthor ? () => setEditingAuthor(false) : null} /> : null}
      {prompting && promptAnalysis ? (
        <AiPromptDialog
          kind={active.kind}
          target={target}
          source={active.source}
          diagnostics={promptAnalysis.diagnostics}
          author={author}
          request={aiRequest}
          onRequestChange={setAiRequest}
          defaultIncludeCurrent={!untouchedTemplate}
          onClose={() => setPrompting(false)}
        />
      ) : null}
      {confirmElement}
    </div>
  );
}

function LibraryPicker({ onOpen, onClose }: { onOpen: (entry: AppCatalogEntry) => Promise<void>; onClose: () => void }) {
  const t = useAppsT();
  const { api, locale } = useStudio();
  const titleId = useId();
  const [items, setItems] = useState<AppCatalogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    appsApi(api)
      .libraryIndex()
      .then((catalog) => {
        if (!cancelled) setItems(catalog.items || []);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorCode(err));
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal-panel apps-dialog wide" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="apps-dialog-head">
          <h3 id={titleId}>{t('sdkOpenFromLibrary')}</h3>
          <button type="button" className="button ghost icon-button" onClick={onClose} aria-label={t('sdkClose')}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <p className="muted">{t('sdkOpenFromLibraryHint')}</p>
        {error ? <Notice kind="error">{t('appLibraryError')}: {error}</Notice> : null}
        {!items && !error ? <p className="empty">{t('loading')}</p> : null}
        <div className="apps-list">
          {(items ?? []).map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="apps-list-row"
              disabled={opening !== null}
              onClick={() => {
                setOpening(entry.id);
                onOpen(entry).catch((err: unknown) => {
                  setError(errorCode(err));
                  setOpening(null);
                });
              }}
            >
              <strong>{localised(entry.name, locale)}</strong>
              <span className="muted mono">
                {entry.id} · v{entry.version} · {entry.kind ?? 'flow'}
              </span>
              {opening === entry.id ? <span className="muted">{t('loading')}</span> : null}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Who writes apps here: asked once per window, never taken from a (shared) account. */
function AuthorDialog({ current, onSave, onClose }: { current: string; onSave: (author: string) => void; onClose: (() => void) | null }) {
  const t = useAppsT();
  const titleId = useId();
  const inputId = useId();
  const [value, setValue] = useState(current);
  const normalized = normalizeAuthor(value);
  return (
    <div className="modal-backdrop">
      <form
        className="modal-panel apps-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(event) => {
          event.preventDefault();
          if (normalized) onSave(normalized);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && onClose) onClose();
        }}
      >
        <h3 id={titleId}>{t('sdkAuthorTitle')}</h3>
        <p className="muted">{t('sdkAuthorCopy')}</p>
        <div className="field">
          <label htmlFor={inputId}>{t('sdkAuthorLabel')}</label>
          <TextInput id={inputId} value={value} maxLength={60} autoFocus onChange={(event) => setValue(event.target.value)} />
          {normalized && normalized !== value.trim() ? <span className="field-note">{t('sdkAuthorNormalized', { author: normalized })}</span> : null}
        </div>
        <div className="actions">
          {onClose ? (
            <button type="button" className="button" onClick={onClose}>
              {t('cancel')}
            </button>
          ) : null}
          <button type="submit" className="button primary" disabled={!normalized}>
            {t('sdkAuthorSave')}
          </button>
        </div>
      </form>
    </div>
  );
}
