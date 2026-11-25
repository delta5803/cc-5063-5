let editSequence = 0;

export class SectionEditHistory {
  constructor(options = {}) {
    this.entries = [];
    this.redoStack = [];
    this.revision = 0;
    this.maxEntries = options.maxEntries ?? 200;
  }

  commit(edit) {
    this.revision += 1;
    const entry = {
      seq: ++editSequence,
      revision: this.revision,
      at: new Date().toISOString(),
      ...edit,
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
    this.redoStack.length = 0;
    return entry;
  }

  undo() {
    const entry = this.entries.pop();
    if (!entry) return null;
    this.revision += 1;
    const undoEntry = { ...entry, undoneAt: new Date().toISOString(), undoRevision: this.revision };
    this.redoStack.push(undoEntry);
    return undoEntry;
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.revision += 1;
    this.entries.push({ ...entry, redoneAt: new Date().toISOString(), revision: this.revision });
    return entry;
  }

  get head() {
    return this.entries[this.entries.length - 1] ?? null;
  }

  toJSON() {
    return { revision: this.revision, entries: this.entries, redoStack: this.redoStack };
  }
}

export function createEditHistory(options) {
  return new SectionEditHistory(options);
}

export function collectSectionIds(input = {}) {
  if (Array.isArray(input.sectionIds)) return [...new Set(input.sectionIds)];
  if (Array.isArray(input.sections)) return [...new Set(input.sections.map((s) => s?.id).filter(Boolean))];
  if (Array.isArray(input.orderedIds)) return [...new Set(input.orderedIds)];
  if (input.surface?.sectionIds) return [...new Set(input.surface.sectionIds)];
  return [];
}

export function checkResultDependencies(result, currentSections = []) {
  const dependencies = result?.dependencies ?? result?.task?.dependencies ?? result ?? {};
  const sectionIds = dependencies.sectionIds
    ?? dependencies.surface?.sectionIds
    ?? result?.surface?.sectionIds
    ?? collectSectionIds(dependencies);
  const currentIds = new Set(currentSections.map((s) => s.id));
  const missingSectionIds = sectionIds.filter((id) => !currentIds.has(id));
  const exists = missingSectionIds.length === 0;

  if (!exists) {
    return {
      current: false,
      fresh: false,
      stale: true,
      valid: false,
      code: 'RESULT_DEPENDENCY_SECTION_MISSING',
      reasonCode: 'SECTION_NO_LONGER_EXISTS',
      missingSectionIds,
      requiredSectionIds: sectionIds,
      message: `结果依赖的截面 ${missingSectionIds.join(', ')} 已不存在（可能已被撤销或删除）；该旧标架或放样结果不得继续驱动视图。`,
    };
  }

  return {
    current: true,
    fresh: true,
    stale: false,
    valid: true,
    code: 'DEPENDENCIES_PRESENT',
    missingSectionIds: [],
    requiredSectionIds: sectionIds,
  };
}

export class SurfaceGenerationTasks {
  constructor(options = {}) {
    this.tasks = new Map();
    this.maxTasks = options.maxTasks ?? 100;
  }

  create(input = {}) {
    const id = input.taskId ?? `loft-task-${this.tasks.size + 1}-${Math.random().toString(36).slice(2, 8)}`;
    const task = {
      id,
      type: 'loft-surface-generation',
      status: 'queued',
      requestedAt: new Date().toISOString(),
      historyRevision: input.historyRevision ?? null,
      parameters: input.parameters ?? {},
      dependencies: {
        sectionIds: collectSectionIds(input),
      },
    };
    this.tasks.set(id, task);
    if (this.tasks.size > this.maxTasks) {
      const oldest = this.tasks.keys().next().value;
      this.tasks.delete(oldest);
    }
    return task;
  }

  acceptResult(taskId, result, currentSections) {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { accepted: false, stale: true, code: 'TASK_NOT_FOUND', message: `未知曲面任务 ${taskId}` };
    }
    const dependencyCheck = checkResultDependencies(
      { ...result, dependencies: { ...(result?.dependencies ?? {}), sectionIds: task.dependencies.sectionIds } },
      currentSections,
    );
    if (!dependencyCheck.valid) {
      task.status = 'stale-dependency';
      task.staleAt = new Date().toISOString();
      task.dependencyCheck = dependencyCheck;
      return { accepted: false, ...dependencyCheck, task };
    }
    task.status = 'completed';
    task.completedAt = new Date().toISOString();
    task.result = result;
    return { accepted: true, valid: true, task, result };
  }

  markFailed(taskId, error) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    task.status = 'failed';
    task.failedAt = new Date().toISOString();
    task.error = { code: error?.code ?? 'LOFT_FAILED', message: error?.message ?? String(error) };
    return task;
  }
}
