// The start-up sequence the splash shows, as pure logic: each step runs in
// order and reports done / warn / skipped; a step may stop and ask (a port
// held by another Gateway, an update) and resumes with the user's answer.
// main.ts supplies the step bodies (Electron, the controller); tests supply
// fakes.
import type { SplashAnswer, SplashPrompt, SplashState, SplashStep, SplashStepId, SplashStepStatus } from '../../shared/areas/app';

export const SPLASH_STEPS: readonly SplashStepId[] = ['settings', 'recovery', 'ports', 'server', 'update'];

export type StepResult = {
  status: Exclude<SplashStepStatus, 'pending' | 'running' | 'blocked'>;
  detail?: string;
  vars?: Record<string, string | number>;
};

export interface StepContext {
  /** Show a question and wait for the answer. */
  ask(prompt: SplashPrompt): Promise<SplashAnswer>;
  /** Update the running step's detail (progress text). */
  progress(detail: string, vars?: Record<string, string | number>): void;
}

export type StepBody = (context: StepContext) => Promise<StepResult>;

export class QuitRequested extends Error {
  constructor() {
    super('quit_requested');
  }
}

export class StartupSequence {
  private state_: SplashState;
  private pending: ((answer: SplashAnswer) => void) | null = null;

  constructor(
    base: Pick<SplashState, 'version' | 'theme' | 'locale'>,
    private readonly onChange: (state: SplashState) => void = () => undefined,
  ) {
    this.state_ = {
      ...base,
      steps: SPLASH_STEPS.map((id) => ({ id, status: 'pending', detail: '' })),
      prompt: null,
      update: null,
      done: false,
    };
  }

  get state(): SplashState {
    return { ...this.state_, steps: this.state_.steps.map((step) => ({ ...step })) };
  }

  patch(patch: Partial<SplashState>): void {
    this.state_ = { ...this.state_, ...patch };
    this.onChange(this.state);
  }

  private setStep(id: SplashStepId, patch: Partial<SplashStep>): void {
    this.state_ = { ...this.state_, steps: this.state_.steps.map((step) => (step.id === id ? { ...step, ...patch } : step)) };
    this.onChange(this.state);
  }

  /** The splash's answer to the current prompt (ignored when none is open). */
  answer(answer: SplashAnswer): void {
    const resolve = this.pending;
    if (!resolve) return;
    this.pending = null;
    resolve(answer);
  }

  /**
   * Runs every step in order. A step that throws is shown as a warning and
   * the sequence goes on (start-up never gets stuck); QuitRequested stops it
   * and rejects.
   */
  async run(bodies: Partial<Record<SplashStepId, StepBody>>): Promise<SplashState> {
    for (const id of SPLASH_STEPS) {
      const body = bodies[id];
      if (!body) {
        this.setStep(id, { status: 'skipped', detail: '' });
        continue;
      }
      this.setStep(id, { status: 'running', detail: '' });
      const context: StepContext = {
        ask: (prompt) =>
          new Promise<SplashAnswer>((resolve) => {
            this.pending = (answer) => {
              this.state_ = { ...this.state_, prompt: null };
              this.setStep(id, { status: 'running' });
              resolve(answer);
            };
            this.state_ = { ...this.state_, prompt };
            this.setStep(id, { status: 'blocked' });
          }),
        progress: (detail, vars) => this.setStep(id, { detail, ...(vars ? { vars } : {}) }),
      };
      try {
        const result = await body(context);
        this.setStep(id, { status: result.status, detail: result.detail ?? '', ...(result.vars ? { vars: result.vars } : {}) });
      } catch (error) {
        if (error instanceof QuitRequested) throw error;
        this.setStep(id, { status: 'warn', detail: 'failed', vars: { error: error instanceof Error ? error.message : String(error) } });
      }
    }
    this.patch({ done: true, prompt: null });
    return this.state;
  }
}

/** Resolves true when `check` holds, polling every `intervalMs`, or false after `timeoutMs`. */
export async function waitFor(check: () => boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return true;
    if (Date.now() >= end) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
