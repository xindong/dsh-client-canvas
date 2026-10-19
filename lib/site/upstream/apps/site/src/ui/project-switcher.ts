import { createIcon } from "./icons";
import type { SiteProject } from "../project-store";

export type SiteProjectSummary = Omit<SiteProject, "document">;

type ProjectSwitcherControls = {
  root: HTMLElement;
  trigger: HTMLButtonElement;
  triggerIcon: HTMLElement;
  current: HTMLElement;
  menu: HTMLElement;
  list: HTMLElement;
  newButton: HTMLButtonElement;
};

type ProjectSwitcherActions = {
  onOpenProject: (project: SiteProjectSummary) => void;
  onCreateProject: () => void;
  onDeleteProject: (project: SiteProjectSummary) => void;
  onRenameProject: (project: SiteProjectSummary, name: string) => void;
};

export class ProjectSwitcherController {
  private readonly root: HTMLElement;
  private readonly trigger: HTMLButtonElement;
  private readonly triggerIcon: HTMLElement;
  private readonly current: HTMLElement;
  private readonly menu: HTMLElement;
  private readonly list: HTMLElement;
  private readonly newButton: HTMLButtonElement;
  private actions: ProjectSwitcherActions = {
    onOpenProject: () => {},
    onCreateProject: () => {},
    onDeleteProject: () => {},
    onRenameProject: () => {},
  };
  private currentProject: SiteProjectSummary | null = null;
  private projects: SiteProjectSummary[] = [];
  private renamingProjectId: string | null = null;
  private confirmingDeleteProjectId: string | null = null;

  constructor(controls: ProjectSwitcherControls) {
    this.root = controls.root;
    this.trigger = controls.trigger;
    this.triggerIcon = controls.triggerIcon;
    this.current = controls.current;
    this.menu = controls.menu;
    this.list = controls.list;
    this.newButton = controls.newButton;

    this.triggerIcon.replaceChildren(createIcon("chevronDown", { size: 14, strokeWidth: 2.2 }));
    this.newButton.prepend(createIcon("plus", { size: 14 }));
    this.bindEvents();
  }

  setActions(actions: ProjectSwitcherActions): void {
    this.actions = actions;
  }

  setProjects(projects: SiteProjectSummary[], currentProject: SiteProjectSummary | null): void {
    this.projects = projects;
    this.currentProject = currentProject;
    this.renamingProjectId = null;
    this.confirmingDeleteProjectId = null;
    this.render();
  }

  close(): void {
    this.setOpen(false);
  }

  private bindEvents(): void {
    this.root.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });

    this.trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      this.setOpen(this.menu.hidden);
    });

    this.menu.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    this.newButton.addEventListener("click", () => {
      this.renamingProjectId = null;
      this.actions.onCreateProject();
    });

    document.addEventListener("click", () => {
      this.setOpen(false);
    });
  }

  private setOpen(open: boolean): void {
    this.menu.hidden = !open;
    this.trigger.setAttribute("aria-expanded", String(open));
    if (!open) {
      this.renamingProjectId = null;
      this.confirmingDeleteProjectId = null;
    }
  }

  private render(): void {
    this.current.textContent = this.currentProject?.name ?? "画布";
    this.list.replaceChildren(...this.projects.map((project) => this.renderProjectItem(project)));
  }

  private renderProjectItem(project: SiteProjectSummary): HTMLElement {
    const item = document.createElement("div");
    item.className = "project-item";
    const active = project.id === this.currentProject?.id;
    item.dataset.active = String(active);

    if (active && this.renamingProjectId === project.id) {
      item.append(this.renderRenameForm(project));
      return item;
    }

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "project-item-open";
    openButton.textContent = project.name;
    openButton.addEventListener("click", () => {
      if (project.id === this.currentProject?.id) {
        this.close();
        return;
      }
      this.close();
      this.actions.onOpenProject(project);
    });

    item.append(openButton);

    if (active) {
      const renameButton = document.createElement("button");
      renameButton.type = "button";
      renameButton.className = "project-item-edit project-item-rename-button";
      renameButton.title = "修改名称";
      renameButton.setAttribute("aria-label", "修改当前画布名称");
      renameButton.replaceChildren(createIcon("pencil", { size: 14 }));
      renameButton.addEventListener("click", () => {
        this.renamingProjectId = project.id;
        this.render();
      });
      item.append(renameButton);
    } else {
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "project-item-edit project-item-delete";
      deleteButton.title = this.confirmingDeleteProjectId === project.id ? "再次点击确认删除" : "删除画布";
      deleteButton.setAttribute("aria-label", deleteButton.title);
      if (this.confirmingDeleteProjectId === project.id) {
        deleteButton.textContent = "确认";
        deleteButton.dataset.confirming = "true";
      } else {
        deleteButton.replaceChildren(createIcon("delete", { size: 14 }));
      }
      deleteButton.addEventListener("click", () => {
        if (this.confirmingDeleteProjectId === project.id) {
          this.confirmingDeleteProjectId = null;
          this.close();
          this.actions.onDeleteProject(project);
          return;
        }
        this.confirmingDeleteProjectId = project.id;
        this.render();
      });
      item.append(deleteButton);
    }

    return item;
  }

  private renderRenameForm(project: SiteProjectSummary): HTMLFormElement {
    const form = document.createElement("form");
    form.className = "project-item-rename";
    const input = document.createElement("input");
    input.className = "project-item-input";
    input.value = project.name;
    input.maxLength = 64;
    input.setAttribute("aria-label", "画布名称");
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "project-item-action project-item-save";
    submit.title = "保存";
    submit.setAttribute("aria-label", "保存画布名称");
    submit.replaceChildren(createIcon("save", { size: 14 }));

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = input.value.trim();
      if (!name || name === this.currentProject?.name) {
        this.renamingProjectId = null;
        this.render();
        return;
      }
      this.actions.onRenameProject(project, name);
    });

    input.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      this.renamingProjectId = null;
      this.render();
    });

    form.append(input, submit);
    window.requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    return form;
  }
}
