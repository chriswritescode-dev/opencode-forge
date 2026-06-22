import { render } from 'solid-js/web'
import { App } from './app'

const root = document.getElementById('forge-app-root')
if (root) render(App, root)
