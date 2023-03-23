import { Backend, FileStore } from "./backend/mod.ts";
import { KeyBindings } from "./action/keybinds.ts";
import { CommandRegistry } from "./action/commands.ts";
import { Module, Node, RawNode } from "./manifold/mod.ts";
import { MenuRegistry } from "./action/menus.ts";


export interface Context {
  node: Node|null;
  nodes?: Node[];
  event?: Event;
  panel: Panel;
}

export class Panel {
  id: string;
  history: Node[];

  constructor(head: Node) {
    this.id = Math.random().toString(36).substring(2);
    this.history = [head];
  }

  open(node: Node) {
    this.history.push(node);
  }

  back() {
    this.history.pop();
  }

  get currentNode(): Node {
    return this.history[this.history.length-1];
  }

  get headNode(): Node {
    return this.history[0];
  }
}


class Workspace {
  fs: FileStore;
  module: Module;

  lastOpenedID: string;
  expanded: {[key: string]: {[key: string]: boolean}}; // [rootid][id]

  constructor(fs: FileStore) {
    this.fs = fs;
    this.module = new Module();
    this.expanded = {};

    this.writeDebounce = debounce(async (path, contents) => {
      try {
        await this.fs.writeFile(path, contents);
        console.log("Saved workspace.");
      } catch (e: Error) {
        console.error(e);
        document.dispatchEvent(new CustomEvent("BackendError"));
      }
    });
  }

  get rawNodes(): RawNode[] {
    return Object.values(this.module.nodes);
  }

  get observers(): ((n: Node) => void)[] {
    return this.module.observers;
  }

  save() {
    this.writeDebounce("workspace.json", JSON.stringify({
      version: 1,
      lastopen: this.lastOpenedID,
      expanded: this.expanded,
      nodes: this.rawNodes
    }, null, 2));
  }

  async load() {
    let doc = JSON.parse(await this.fs.readFile("workspace.json") || "{}");
    if (Array.isArray(doc)) {
      doc = {
        version: 0,
        nodes: doc
      }
    }
    if (doc.nodes) {
      this.module.import(doc.nodes);
    }
    if (doc.expanded) {
      this.expanded = doc.expanded;
    }
    if (doc.lastopen) {
      this.lastOpenedID = doc.lastopen;
    }
    
  }

  mainNode(): Node {
    let main = this.module.find("@workspace");
    if (!main) {
      const root = this.module.find("@root");
      const ws = this.module.new("@workspace");
      ws.setName("Workspace");
      ws.setParent(root);
      const cal = this.module.new("@calendar");
      cal.setName("Calendar");
      cal.setParent(ws);
      const home = this.module.new("Home");
      home.setParent(ws);
      main = ws;
    }
    return main;
  }

  find(path:string): Node|null {
    return this.module.find(path)
  }

  new(name: string, value?: any): Node {
    return this.module.new(name, value);
  }


  getExpanded(head: Node, n: Node): boolean {
    if (!this.expanded[head.ID]) {
      this.expanded[head.ID] = {};
    }
    let expanded = this.expanded[head.ID][n.ID];
    if (expanded === undefined) {
      expanded = false;
    }
    return expanded;
  }

  setExpanded(head: Node, n: Node, b: boolean) {
    this.expanded[head.ID][n.ID] = b;
    this.save();
    //localStorage.setItem(this.expandedKey, JSON.stringify(this.expanded));
  }

  findAbove(head: Node, n: Node): Node|null {
    if (n.ID === head.ID) {
      return null;
    }
    let above = n.getPrevSibling();
    if (!above) {
      return n.getParent();
    }
    const lastChildIfExpanded = (n: Node): Node => {
      const expanded = this.getExpanded(head, n);
      if (!expanded || n.childCount() === 0) {
        return n;
      }
      const lastChild = n.getChildren()[n.childCount() - 1];
      return lastChildIfExpanded(lastChild);
    }
    return lastChildIfExpanded(above);
  }

  findBelow(head: Node, n: Node): Node|null {
    // TODO: find a way to indicate pseudo "new" node for expanded leaf nodes
    if (this.getExpanded(head, n) && n.childCount() > 0) {
      return n.getChildren()[0];
    }
    const nextSiblingOrParentNextSibling = (n: Node): Node|null => {
      const below = n.getNextSibling();
      if (below) {
        return below;
      }
      const parent = n.getParent();
      if (!parent || parent.ID === head.ID) {
        return null;
      }
      return nextSiblingOrParentNextSibling(parent);
    }
    return nextSiblingOrParentNextSibling(n);
  }

}


function debounce(func, timeout = 3000){
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => { func.apply(this, args); }, timeout);
  };
}


export class Workbench {
  commands: CommandRegistry;
  keybindings: KeyBindings;
  menus: MenuRegistry;

  backend: Backend;
  workspace: Workspace;
  
  context: Context;
  panels: Panel[][]; // Panel[row][column]

  menu: any;
  notice: any;
  palette: any;
  quickadd: any;
  curtain: any;

  constructor(backend: Backend) {
    this.commands = new CommandRegistry();
    this.keybindings = new KeyBindings();
    this.menus = new MenuRegistry();

    this.backend = backend;
    this.workspace = new Workspace(backend.files);

    this.context = {node: null};
    this.panels = [[]];
    
  }

  get mainPanel(): Panel {
    return this.panels[0][0];
  }

  async initialize() {
    await this.workspace.load();
    this.workspace.rawNodes.forEach(n => this.backend.index.index(n));
    this.workspace.observers.push((n => {
      this.workspace.save();
      this.backend.index.index(n.raw);
      n.getComponentNodes().forEach(com => this.backend.index.index(com.raw));
    }));
    
    if (this.workspace.lastOpenedID) {
      this.openNewPanel(this.workspace.find(this.workspace.lastOpenedID) || this.workspace.mainNode());
    } else {
      this.openNewPanel(this.workspace.mainNode());
    }
    
    m.redraw();


    if (!localStorage.getItem("firsttime")) {
      this.showNotice('firsttime');
    }
    
  }

  authenticated(): boolean {
    return this.backend.auth && this.backend.auth.currentUser();
  }

  closeQuickAdd() {
    this.quickadd = null;
    m.redraw();
  }

  openQuickAdd() {
    let node = this.workspace.find("@quickadd");
    if (!node) {
      node = this.workspace.new("@quickadd");
    }
    this.quickadd = node;
  }

  commitQuickAdd() {
    const node = this.workspace.find("@quickadd");
    if (!node) return;
    const today = this.todayNode();
    node.getChildren().forEach(n => n.setParent(today));
  }

  clearQuickAdd() {
    const node = this.workspace.find("@quickadd");
    if (!node) return;
    node.getChildren().forEach(n => n.destroy());
  }

  // TODO: goto workspace
  todayNode(): ManfioldNode {
    const today = new Date();
    const dayNode = today.toUTCString().split(today.getFullYear())[0];
    const weekNode = `Week ${String(getWeekOfYear(today)).padStart(2, "0")}`;
    const yearNode = `${today.getFullYear()}`;
    const todayPath = ["@workspace", "Calendar", yearNode, weekNode, dayNode].join("/");
    let todayNode = this.workspace.find(todayPath);
    if (!todayNode) {
      todayNode = this.workspace.new(todayPath);
    }
    return todayNode;
  }

  openToday() {
    this.open(this.todayNode());
  }

  open(n: Node) {
    // TODO: not sure this is still necessary
    if (!this.workspace.expanded[n.ID]) {
      this.workspace.expanded[n.ID] = {};
    }

    this.workspace.lastOpenedID = n.ID;
    this.workspace.save();
    const p = new Panel(n);
    this.panels[0][0] = p
    this.context.panel = p;
  }

  openNewPanel(n: Node) {
    // TODO: not sure this is still necessary
    if (!this.workspace.expanded[n.ID]) {
      this.workspace.expanded[n.ID] = {};
    }

    this.workspace.lastOpenedID = n.ID;
    this.workspace.save();
    const p = new Panel(n);
    this.panels[0].push(p);
    this.context.panel = p;
  }

  closePanel(panel: Panel) {
    this.panels.forEach((row, ridx) => {
      this.panels[ridx] = row.filter(p => p !== panel);
    });
  }

  defocus() {
    this.context.node = null;
  }

  focus(n: Node, panel?: Panel, pos?: number = 0) {
    this.context.node = n;
    if (panel) {
      this.context.panel = panel;
    }
    const input = this.getInput(n, panel);
    if (input) {
      input.focus();
      if (pos !== undefined) {
        input.setSelectionRange(pos,pos);
      }
    }
  }

  getInput(n: Node, panel?: Panel): HTMLElement {
    if (!panel) {
      panel = this.context.panel;
    }
    return document.getElementById(`input-${panel.id}-${n.ID}`);
  }

  executeCommand<T>(id: string, ctx: any, ...rest: any): Promise<T> {
    return this.commands.executeCommand(id, this.newContext(ctx), ...rest);
  }

  newContext(ctx: any): Context {
    return Object.assign({}, this.context, ctx);
  }

  showMenu(event: Event, ctx: any) {
    event.stopPropagation();
    event.preventDefault();
    const trigger = event.target.closest("*[data-menu]");
    const rect = trigger.getBoundingClientRect();
    const align = trigger.dataset["align"] || "left";
    let x = document.body.scrollLeft+rect.x;
    if (align === "right") {
      x = document.body.offsetWidth - rect.right;
    }
    const y = document.body.scrollTop+rect.y+rect.height;
    const items = this.menus.menus[trigger.dataset["menu"]];
    const cmds = items.filter(i => i.command).map(i => this.commands.commands[i.command]);
    if (!items) return;
    this.menu = {x, y, 
      ctx: this.newContext(ctx), 
      items: items,
      commands: cmds,
      align: align
    };
    this.curtain = {
      visible: false,
      onclick: () => this.hideMenu()
    }
    m.redraw();
  }

  hideMenu() {
    this.menu = null;
    this.curtain = null;
    m.redraw();
  }

  showPalette(x: number, y: number, ctx: Context) {
    this.palette = {x, y, ctx: ctx};
    this.curtain = {
      visible: false,
      onclick: () => this.hidePalette()
    }
    m.redraw();
  }

  hidePalette() {
    this.palette = null;
    this.curtain = null;
    m.redraw();
  }

  showNotice(message, finished) {
    this.notice = {message, finished};
    m.redraw();
  }

  hideNotice() {
    this.notice = null;
    m.redraw();
  }


}


function getWeekOfYear(date) {
  var d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  var dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  var yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
  return Math.ceil((((d - yearStart) / 86400000) + 1)/7);
}