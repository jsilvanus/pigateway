import type { GatewayEventBroker, SpatialScenePayload, SpatialZoneEventPayload } from "../events.js";

export class SpatialStatusStore {
  private currentScene: SpatialScenePayload = {
    updatedAt: new Date(0).toISOString(),
    activeZones: [],
    subjects: [],
    cameras: {},
  };

  private readonly eventBroker?: GatewayEventBroker | undefined;

  constructor(eventBroker?: GatewayEventBroker | undefined) {
    this.eventBroker = eventBroker;
  }

  public get(): SpatialScenePayload {
    return this.currentScene;
  }

  public updateScene(scene: SpatialScenePayload): SpatialScenePayload {
    this.currentScene = scene;
    this.eventBroker?.emit({
      type: "spatial",
      data: scene,
    });
    return this.currentScene;
  }

  public emitZoneEvent(evt: SpatialZoneEventPayload): void {
    this.eventBroker?.emit({
      type: "spatial-zone",
      data: evt,
    });
  }
}
