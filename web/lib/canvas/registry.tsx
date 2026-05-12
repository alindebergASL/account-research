import type { ComponentType } from "react";
import type { CanvasWidget, WidgetKind } from "./schema";
import {
  SectionRefTile,
  EvidenceBoardTile,
  ActionPanelTile,
  OpenQuestionsTile,
  MetricTile,
} from "../../components/canvas/tiles";
import {
  SectionRefDetail,
  EvidenceBoardDetail,
  ActionPanelDetail,
  OpenQuestionsDetail,
  MetricDetail,
} from "../../components/canvas/details";

export interface WidgetDescriptor {
  kind: WidgetKind;
  label: string;
  Tile: ComponentType<{ widget: CanvasWidget }>;
  Detail: ComponentType<{ widget: CanvasWidget }>;
}

export const ALL_WIDGET_KINDS: readonly WidgetKind[] = [
  "section_ref",
  "evidence_board",
  "action_panel",
  "open_questions",
  "metric",
];

const REGISTRY: Record<WidgetKind, WidgetDescriptor> = {
  section_ref: {
    kind: "section_ref",
    label: "Section reference",
    Tile: SectionRefTile as ComponentType<{ widget: CanvasWidget }>,
    Detail: SectionRefDetail as ComponentType<{ widget: CanvasWidget }>,
  },
  evidence_board: {
    kind: "evidence_board",
    label: "Evidence board",
    Tile: EvidenceBoardTile as ComponentType<{ widget: CanvasWidget }>,
    Detail: EvidenceBoardDetail as ComponentType<{ widget: CanvasWidget }>,
  },
  action_panel: {
    kind: "action_panel",
    label: "Action panel",
    Tile: ActionPanelTile as ComponentType<{ widget: CanvasWidget }>,
    Detail: ActionPanelDetail as ComponentType<{ widget: CanvasWidget }>,
  },
  open_questions: {
    kind: "open_questions",
    label: "Open questions",
    Tile: OpenQuestionsTile as ComponentType<{ widget: CanvasWidget }>,
    Detail: OpenQuestionsDetail as ComponentType<{ widget: CanvasWidget }>,
  },
  metric: {
    kind: "metric",
    label: "Metric",
    Tile: MetricTile as ComponentType<{ widget: CanvasWidget }>,
    Detail: MetricDetail as ComponentType<{ widget: CanvasWidget }>,
  },
};

export function getDescriptor(kind: WidgetKind): WidgetDescriptor {
  return REGISTRY[kind];
}
