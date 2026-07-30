// Query Builder workspace layout, stage visibility, and drawer lifecycle helpers.

import { installQueryRovingTabs } from "./gridQueryStageNav.js";

/** Creates the workspace presenter without owning Recipe or host lifecycle state. */
export function createQueryWorkspace({ drawerResize, element, elements, root, uiState }) {
  const stageSections = {
    calculatedValues: [elements.queryCalculatedValuesPanel, elements.queryStageCalculatedValues],
    filterResults: [elements.queryFilterResultsPanel, elements.queryStageFilterResults],
    filterRows: [elements.queryFilterRowsPanel, elements.queryStageFilterRows],
    result: [elements.queryResultPanel, elements.queryStageResult]
  };
  const sectionStages = { queryComputedSection: "calculatedValues", queryPostFilterSection: "filterResults", queryResultSection: "result", queryWhereSection: "filterRows" };

  /** Renders persistent shell state without rebuilding editor controls. */
  function render(ui) {
    elements.queryDrawer.style.height = `${ui.drawerHeight}px`;
    elements.queryDrawer.classList.toggle("query-focus-mode", ui.focusMode);
    elements.queryFocusMode.setAttribute("aria-pressed", String(ui.focusMode));
    elements.queryFocusMode.textContent = ui.focusMode ? "Exit Focus Builder" : "Focus Builder";
    elements.queryStageSelect.value = ui.activeStage;
    for (const [name, [section, tab]] of Object.entries(stageSections)) {
      const selected = name === ui.activeStage;
      if (section) { section.hidden = !selected; section.inert = !selected; section.setAttribute("aria-hidden", String(!selected)); }
      if (tab) { tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1; }
    }
    const reviewTabs = { assistant: elements.queryInspectorAssistant, meaning: elements.queryInspectorMeaning, orm: elements.queryInspectorOrm, problems: elements.queryInspectorProblems };
    for (const [name, tab] of Object.entries(reviewTabs)) {
      const selected = name === ui.inspectorTab;
      if (tab) { tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1; }
    }
    const reviewPanels = { assistant: elements.queryAssistantPanel, meaning: elements.queryMeaningPanel, orm: elements.queryOrmPanel, problems: elements.queryProblemsPanel };
    for (const [name, panel] of Object.entries(reviewPanels)) {
      if (!panel) { continue; }
      const selected = name === ui.inspectorTab;
      panel.hidden = !selected;
      panel.inert = !selected;
      panel.setAttribute("aria-hidden", String(!selected));
    }
    renderMobilePane(ui);
    if (elements.queryEditorPane && Number.isFinite(ui.stageScrollTops?.[ui.activeStage])) { elements.queryEditorPane.scrollTop = ui.stageScrollTops[ui.activeStage]; }
    if (elements.queryPreviewSection && Number.isFinite(ui.inspectorScrollTops?.[ui.inspectorTab])) { elements.queryPreviewSection.scrollTop = ui.inspectorScrollTops[ui.inspectorTab]; }
  }

  /** Renders the narrow-width edit/review switch using persistent workspace state. */
  function renderMobilePane(ui) {
    const switcher = elements.queryMobilePaneSwitch;
    if (!switcher) { return; }
    if (switcher.parentElement !== elements.queryWorkspace) { elements.queryWorkspace.insertBefore(switcher, elements.queryEditorPane); }
    switcher.hidden = false;
    switcher.replaceChildren(...["editor", "review"].map((pane) => {
      const button = element("button", { ariaPressed: String(ui.mobilePane === pane), className: "secondary", type: "button" }, pane === "editor" ? "Edit query" : "Review query");
      button.addEventListener("click", () => uiState.dispatch({ pane, type: "SET_MOBILE_PANE" }));
      return button;
    }));
    elements.queryWorkspace.dataset.mobilePane = ui.mobilePane;
  }

  /** Opens the drawer and activates the requested editor stage. */
  function open(section, { focus = true } = {}) {
    elements.queryDrawer.hidden = false;
    elements.queryDrawerToggle.setAttribute("aria-expanded", "true");
    uiState.dispatch({ open: true, type: "SET_DRAWER_OPEN" });
    drawerResize.setHeight(uiState.getSnapshot().drawerHeight);
    if (sectionStages[section]) { uiState.dispatch({ stage: sectionStages[section], type: "SET_ACTIVE_STAGE" }); }
    if (focus) { window.setTimeout(() => elements[section]?.querySelector("button,input,select,textarea")?.focus(), 0); }
  }

  /** Closes the drawer and restores focus to its visible toggle. */
  function close() {
    elements.queryDrawer.hidden = true;
    elements.queryDrawerToggle.setAttribute("aria-expanded", "false");
    uiState.dispatch({ open: false, type: "SET_DRAWER_OPEN" });
    elements.queryDrawerToggle.focus();
  }

  return { close, installRovingTabs: installQueryRovingTabs, open, render };
}
