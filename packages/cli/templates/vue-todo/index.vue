<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'

const STORAGE_KEY = 'goalmatic-vue-todo:tasks'
const projectType = '{{PROJECT_TYPE}}'
const isLocalhost = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)
const isHostedApp = projectType === 'app' && !isLocalhost
const tasks = ref([])
const draft = ref('')
const filter = ref('all')
const busy = ref(false)
const loading = ref(true)
const error = ref('')
const mode = ref(isHostedApp ? 'live' : projectType === 'app' ? 'demo' : 'local')
let requestGeneration = 0
let accountKey = ''
let unsubscribeAuth

const visibleTasks = computed(() => tasks.value.filter(task => (
  filter.value === 'all' || (filter.value === 'done' ? task.completed : !task.completed)
)))
const remaining = computed(() => tasks.value.filter(task => !task.completed).length)
const completed = computed(() => tasks.value.length - remaining.value)

function messageFor(error) {
  return error instanceof Error && error.message ? error.message : 'The request did not finish. Try again.'
}

function normalize(record) {
  return { id: String(record.id), title: String(record.title || '').trim(), completed: Boolean(record.completed) }
}

function saveDemo() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks.value))
}

function loadDemo() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    tasks.value = Array.isArray(saved) ? saved.map(normalize).filter(task => task.title) : []
  } catch {
    tasks.value = []
  }
}

function requireRuntime() {
  if (!window.GoalmaticAuth || !window.GoalmaticData) {
    throw new Error('This hosted App needs GoalmaticAuth and GoalmaticData. Reopen it from Goalmatic after installation, then reload.')
  }
}

async function reload() {
  const generation = ++requestGeneration
  error.value = ''
  loading.value = true
  try {
    if (!isHostedApp) {
      loadDemo()
      return
    }
    requireRuntime()
    const user = await window.GoalmaticAuth.getUser()
    if (!user) throw new Error('Your Goalmatic session is unavailable. Sign in again, then reload this App.')
    const result = await window.GoalmaticData.fetchAll('todos', { pageSize: 100, maxRecords: 500 })
    if (generation !== requestGeneration) return
    tasks.value = result.records.map(normalize).filter(task => task.title)
  } catch (cause) {
    if (generation !== requestGeneration) return
    if (isHostedApp) tasks.value = []
    error.value = messageFor(cause)
  } finally {
    if (generation === requestGeneration) loading.value = false
  }
}

async function addTask() {
  const title = draft.value.trim()
  if (!title || busy.value) return
  busy.value = true
  error.value = ''
  try {
    if (!isHostedApp) {
      tasks.value.unshift({ id: crypto.randomUUID(), title, completed: false })
      saveDemo()
    } else {
      requireRuntime()
      await window.GoalmaticData.submit('todos', { title, completed: false })
      await reload()
    }
    draft.value = ''
  } catch (cause) {
    error.value = messageFor(cause)
  } finally {
    busy.value = false
  }
}

async function toggleTask(task) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    if (!isHostedApp) {
      task.completed = !task.completed
      saveDemo()
    } else {
      requireRuntime()
      await window.GoalmaticData.update('todos', task.id, { title: task.title, completed: !task.completed })
      await reload()
    }
  } catch (cause) {
    error.value = messageFor(cause)
  } finally {
    busy.value = false
  }
}

async function removeTask(task) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    if (!isHostedApp) {
      tasks.value = tasks.value.filter(item => item.id !== task.id)
      saveDemo()
    } else {
      requireRuntime()
      await window.GoalmaticData.remove('todos', task.id)
      await reload()
    }
  } catch (cause) {
    error.value = messageFor(cause)
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  await reload()
  if (isHostedApp && window.GoalmaticAuth?.onAuthChange) {
    accountKey = `${window.GoalmaticAuth.account?.id || ''}:${window.GoalmaticAuth.user?.id || ''}`
    unsubscribeAuth = window.GoalmaticAuth.onAuthChange(user => {
      const nextKey = `${window.GoalmaticAuth.account?.id || ''}:${user?.id || ''}`
      if (nextKey === accountKey) return
      accountKey = nextKey
      tasks.value = []
      draft.value = ''
      void reload()
    })
  }
})
onUnmounted(() => {
  requestGeneration++
  if (typeof unsubscribeAuth === 'function') unsubscribeAuth()
})
</script>

<template>
  <main class="shell">
    <section class="todo-card" aria-labelledby="page-title">
      <header class="topline">
        <div>
          <p class="kicker">{{ mode === 'live' ? 'Your Goalmatic tasks' : 'Your browser tasks' }}</p>
          <h1 id="page-title">Today</h1>
        </div>
        <span class="mode" :class="mode">{{ mode === 'live' ? 'Live' : mode === 'demo' ? 'Demo' : 'Local' }}</span>
      </header>

      <p v-if="mode === 'demo'" class="demo-note">Demo mode saves sample tasks only in this browser. Open the installed App in Goalmatic for private account data.</p>

      <p class="summary">{{ remaining }} {{ remaining === 1 ? 'task' : 'tasks' }} left <span v-if="completed">· {{ completed }} done</span></p>

      <form class="composer" @submit.prevent="addTask">
        <label class="sr-only" for="task-title">New task</label>
        <input id="task-title" v-model="draft" :disabled="busy || loading || (isHostedApp && Boolean(error))" maxlength="160" autocomplete="off" placeholder="What needs your attention?" />
        <button type="submit" :disabled="busy || loading || (isHostedApp && Boolean(error)) || !draft.trim()">Add task</button>
      </form>

      <div class="toolbar" aria-label="Filter tasks">
        <button v-for="option in [{ id: 'all', label: 'All' }, { id: 'open', label: 'Open' }, { id: 'done', label: 'Done' }]" :key="option.id" class="filter" :class="{ selected: filter === option.id }" type="button" :aria-pressed="filter === option.id" @click="filter = option.id">{{ option.label }}</button>
        <button class="reload" type="button" :disabled="loading || busy" @click="reload">Reload</button>
      </div>

      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="loading" class="state" role="status">Loading tasks…</p>
      <p v-else-if="!visibleTasks.length" class="state">{{ tasks.length ? 'Nothing matches this filter.' : 'Add your first task to start your list.' }}</p>

      <ul v-else class="tasks" aria-live="polite">
        <li v-for="task in visibleTasks" :key="task.id" :class="{ completed: task.completed }">
          <button class="check" type="button" :aria-label="`${task.completed ? 'Reopen' : 'Complete'} ${task.title}`" :aria-pressed="task.completed" :disabled="busy || loading || (isHostedApp && Boolean(error))" @click="toggleTask(task)">
            <span aria-hidden="true">{{ task.completed ? '✓' : '' }}</span>
          </button>
          <span class="task-title">{{ task.title }}</span>
          <button class="remove" type="button" :aria-label="`Remove ${task.title}`" :disabled="busy || loading || (isHostedApp && Boolean(error))" @click="removeTask(task)">Remove</button>
        </li>
      </ul>
    </section>
  </main>
</template>

<style>
:root { color: #17322d; background: #f5f7f8; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-synthesis: none; }
* { box-sizing: border-box; } body { min-width: 320px; margin: 0; } button, input { font: inherit; } button { cursor: pointer; } button:disabled, input:disabled { cursor: not-allowed; opacity: .58; } button:focus-visible, input:focus-visible { outline: 3px solid #77b8a6; outline-offset: 2px; }
.shell { display: grid; min-height: 100vh; padding: 24px; place-items: center; }.todo-card { width: min(100%, 680px); padding: clamp(24px, 6vw, 48px); border: 1px solid #d9e3e0; border-radius: 24px; background: #fff; box-shadow: 0 18px 44px rgba(27, 64, 56, .09); }.topline { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }.kicker { margin: 0 0 7px; color: #55716b; font-size: .9rem; }h1 { margin: 0; font-size: clamp(2.25rem, 7vw, 3.5rem); line-height: .95; letter-spacing: -.06em; }.mode { flex: none; padding: 7px 10px; border-radius: 999px; font-size: .8rem; font-weight: 700; }.mode.live { background: #d9f2e8; color: #1b6955; }.mode.demo, .mode.local { background: #edf1f0; color: #55716b; }.demo-note { margin: 18px 0 0; padding: 10px 12px; border-radius: 10px; color: #55716b; background: #f5f7f8; font-size: .9rem; }.summary { margin: 22px 0; color: #55716b; }.composer { display: flex; gap: 9px; }.composer input { min-width: 0; flex: 1; padding: 13px 14px; border: 1px solid #bed0cb; border-radius: 12px; color: #17322d; background: #fff; }.composer button { padding: 12px 16px; border: 0; border-radius: 12px; color: #fff; background: #236956; font-weight: 700; }.toolbar { display: flex; align-items: center; gap: 6px; padding: 23px 0 11px; border-bottom: 1px solid #e7edeb; }.filter, .reload, .remove { border: 0; color: #55716b; background: transparent; }.filter { padding: 7px 10px; border-radius: 8px; }.filter.selected { color: #17322d; background: #e8f1ee; font-weight: 700; }.reload { margin-left: auto; padding: 7px; text-decoration: underline; }.remove { padding: 7px; font-size: .85rem; text-decoration: underline; }.tasks { padding: 0; margin: 0; list-style: none; }.tasks li { display: flex; align-items: center; gap: 12px; min-height: 64px; border-bottom: 1px solid #edf1f0; }.task-title { min-width: 0; flex: 1; overflow-wrap: anywhere; }.completed .task-title { color: #758783; text-decoration: line-through; }.check { display: grid; width: 24px; height: 24px; flex: none; padding: 0; place-items: center; border: 1.5px solid #89a49d; border-radius: 50%; color: #fff; background: #fff; font-size: .85rem; }.completed .check { border-color: #236956; background: #236956; }.state, .error { margin: 25px 0 6px; padding: 13px; border-radius: 10px; }.state { color: #55716b; background: #f5f7f8; }.error { color: #8a2d28; background: #fcebea; }.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
@media (max-width: 480px) { .shell { padding: 12px; align-items: start; }.todo-card { padding: 24px 18px; border-radius: 18px; }.composer { align-items: stretch; flex-direction: column; }.composer button { min-height: 46px; }.remove { padding-right: 0; } } @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition: none !important; } }
</style>
