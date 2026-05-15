import type { ComponentType } from "react";
import type { CanvasWidget, WidgetKind } from "./schema";
import {
  SectionRefTile,
  EvidenceBoardTile,
  ActionPanelTile,
  OpenQuestionsTile,
  MetricTile,
  ExtensionTile,
  StrategicSignalRadarTile,
  OpportunityRiskSplitTile,
  MomentumStripTile,
  AITakeawaysTile,
} from "../../components/canvas/tiles";
import {
  SectionRefDetail,
  EvidenceBoardDetail,
  ActionPanelDetail,
  OpenQuestionsDetail,
  MetricDetail,
  ExtensionDetail,
  StrategicSignalRadarDetail,
  OpportunityRiskSplitDetail,
  MomentumStripDetail,
  AITakeawaysDetail,
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
  "extension",
  "strategic_signal_radar",
  "opportunity_risk_split",
  "momentum_strip",
  "ai_takeaways",
];

const REGISTRY: Record<WidgetKind, WidgetDescriptor> = {
  section_ref: {
    kind: "section_ref",
    label: "Brief insight",
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
    label: "Recommended move",
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
    label: "Account signal",
    Tile: MetricTile as ComponentType<{ widget: CanvasWidget }>,
    Detail: MetricDetail as ComponentType<{ widget: CanvasWidget }>,
  },
  extension: {
    kind: "extension",
    label: "Insight",
    Tile: ExtensionTile as ComponentType<{ widget: CanvasWidget }>,
    Detail: ExtensionDetail as ComponentType<{ widget: CanvasWidget }>,
  },
  strategic_signal_radar: {
    kind: "strategic_signal_radar",
    label: "Strategic signal radar",
    Tile: StrategicSignalRadarTile as ComponentType<{ widget: CanvasWidget }>,
    Detail: StrategicSignalRadarDetail as ComponentType<{ widget: CanvasWidget }>,
  },
  opportunity_risk_split: {
    kind: "opportunity_risk_split",
    label: "Opportunity / risk split",
    Tile: OpportunityRiskSplitTile as ComponentType<{ widget: CanvasWidget }>,
    Detail: OpportunityRiskSplitDetail as ComponentType<{ widget: CanvasWidget }>,
  },
  momentum_strip: {
    kind: "momentum_strip",
    label: "Momentum",
    Tile: MomentumStripTile as ComponentType<{ widget: CanvasWidget }>,
    Detail: MomentumStripDetail as ComponentType<{ widget: CanvasWidget }>,
  },
  ai_takeaways: {
    kind: "ai_takeaways",
    label: "AI takeaways",
    Tile: AITakeawaysTile as ComponentType<{ widget: CanvasWidget }>,
    Detail: AITakeawaysDetail as ComponentType<{ widget: CanvasWidget }>,
  },
};

export function getDescriptor(kind: WidgetKind): WidgetDescriptor {
  return REGISTRY[kind];
}
