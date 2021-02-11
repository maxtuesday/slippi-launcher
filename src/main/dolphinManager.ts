import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { randomBytes } from "crypto";
import { app } from "electron";
import electronSettings from "electron-settings";
import { EventEmitter } from "events";
import * as fs from "fs-extra";
import { find, remove } from "lodash";
import path from "path";
import { DolphinType, findDolphinExecutable } from "common/dolphin";

electronSettings.configure({
  fileName: "Settings",
  prettify: true,
});

export interface ReplayCommunication {
  mode: "normal" | "mirror" | "queue"; // default normal
  replay?: string; // path to the replay if in normal or mirror mode
  startFrame?: number; // when to start watching the replay
  endFrame?: number; // when to stop watching the replay
  commandId?: string; // random string, doesn't really matter
  outputOverlayFiles?: boolean; // outputs gameStartAt and gameStation to text files (only works in queue mode)
  isRealTimeMode?: boolean; // default true; keeps dolphin fairly close to real time (about 2-3 frames); only relevant in mirror mode
  shouldResync?: boolean; // default true; disables the resync functionality
  rollbackDisplayMethod?: "off" | "normal" | "visible"; // default off; normal shows like a player experienced it, visible shows ALL frames (normal and rollback)
  queue?: ReplayQueueItem[];
}

export interface ReplayQueueItem {
  path: string;
  startFrame?: number;
  endFrame?: number;
  gameStartAt?: string;
  gameStation?: string;
}

interface DolphinInstance {
  dolphinUseType: "playback" | "spectate" | "config" | "netplay";
  index?: number; // should refer to the index in relation to the list of sources for spectating
  dolphin?: ChildProcessWithoutNullStreams;
  commFilePath?: string;
}

interface DolphinInstances {
  playback: DolphinInstance | null;
  spectate: DolphinInstance[] | null;
  netplay: DolphinInstance | null;
  configNetplay: DolphinInstance | null;
  configPlayback: DolphinInstance | null;
}

async function generateCommunicationFilePath(
  dolphinUseType: "playback" | "spectate" | "config" | "netplay",
): Promise<string> {
  const tmpDir = app.getPath("temp");
  const uniqueId = randomBytes(3 * 4).toString("hex");
  const commFileName = `slippi-${dolphinUseType}-${uniqueId}.txt`;
  const commFileFullPath = path.join(tmpDir, commFileName);

  return commFileFullPath;
}

// DolphinManager should be in control of all dolphin instances that get opened for actual use.
// This includes playing netplay, viewing replays, watching broadcasts (spectating), and configuring Dolphin.
// The openDolphin function is exported so other parts of the app can do some checks.
export class DolphinManager extends EventEmitter {
  private static instance: DolphinManager;

  // max instances: playback, config, netplay - 1 | spectate - "infinite"
  private dolphinInstances: DolphinInstances = {
    playback: null,
    spectate: null,
    netplay: null,
    configNetplay: null,
    configPlayback: null,
  };

  public static getInstance(): DolphinManager {
    if (!DolphinManager.instance) {
      DolphinManager.instance = new DolphinManager();
    }
    return DolphinManager.instance;
  }

  public async launchDolphin(
    dolphinUseType: "playback" | "spectate" | "config" | "netplay",
    index: number,
    replayComm?: ReplayCommunication,
    dolphinType?: DolphinType,
  ): Promise<void> {
    // I hate how this is done
    const isoParams: string[] = [];
    const meleeISOPath = await electronSettings.get("settings.isoPath");
    if (meleeISOPath?.toString()) {
      isoParams.push("-b", "-e", meleeISOPath.toString());
    }

    switch (dolphinUseType) {
      case "playback": {
        if (!this.dolphinInstances.playback) {
          const commFilePath = await generateCommunicationFilePath(dolphinUseType);

          const dolphin = await this.startDolphin(DolphinType.PLAYBACK, commFilePath, isoParams);
          this.dolphinInstances.playback = {
            dolphinUseType: "playback",
            dolphin: dolphin,
            commFilePath: commFilePath,
          };

          dolphin.on("close", async () => {
            await fs.unlink(commFilePath);
            this.dolphinInstances.playback = null;
          });
        }

        if (this.dolphinInstances.playback.commFilePath) {
          await fs.writeFile(this.dolphinInstances.playback.commFilePath, JSON.stringify(replayComm));
        }

        break;
      }

      case "spectate": {
        if (index < 0) {
          throw Error("Must have a valid index");
        }
        let dolphinInstance: DolphinInstance | undefined = find(this.dolphinInstances.spectate, ["index", index]);
        if (!dolphinInstance?.dolphin) {
          const commFilePath = await generateCommunicationFilePath(dolphinUseType);
          const dolphin = await this.startDolphin(DolphinType.PLAYBACK, commFilePath, isoParams);
          dolphinInstance = {
            dolphinUseType: dolphinUseType,
            index: index,
            commFilePath: commFilePath,
            dolphin: dolphin,
          };

          // create an array of DolphinInstances if this is our first time launching a spectator client
          if (this.dolphinInstances.spectate === null) {
            this.dolphinInstances.spectate = [dolphinInstance];
          } else {
            this.dolphinInstances.spectate.push(dolphinInstance);
          }

          dolphin.on("close", async () => {
            await fs.unlink(commFilePath);
            if (this.dolphinInstances.spectate) {
              remove(this.dolphinInstances.spectate, (instance) => instance.index === index);
            }
          });
        }
        if (dolphinInstance.commFilePath) {
          await fs.writeFile(dolphinInstance.commFilePath, JSON.stringify(replayComm));
        }

        break;
      }

      case "netplay": {
        if (!this.dolphinInstances.netplay) {
          const dolphin = await this.startDolphin(DolphinType.NETPLAY, undefined, isoParams);
          this.dolphinInstances.netplay = {
            dolphinUseType: "netplay",
            dolphin: dolphin,
          };

          dolphin.on("close", () => {
            this.dolphinInstances.netplay = null;
          });
        }

        break;
      }

      case "config": {
        let configureType = "";
        if (dolphinType === DolphinType.NETPLAY) {
          configureType = "configNetplay";
        } else if (dolphinType === DolphinType.PLAYBACK) {
          configureType = "configPlayback";
        } else {
          throw Error("Must define a dolphin type for configuration");
        }

        const dolphin = await this.startDolphin(dolphinType);
        this.dolphinInstances[configureType] = {
          dolphinUseType: "config",
          dolphin: dolphin,
        };

        dolphin.on("close", () => {
          this.dolphinInstances[configureType] = null;
        });

        break;
      }
    }
  }

  private async startDolphin(
    dolphinType: DolphinType,
    commFilePath?: string,
    additionalParams?: string[],
  ): Promise<ChildProcessWithoutNullStreams> {
    const dolphinPath = await findDolphinExecutable(dolphinType);

    const params = [];
    if (commFilePath) {
      params.push("-i", commFilePath);
    }
    if (additionalParams) {
      params.push(...additionalParams);
    }
    return spawn(dolphinPath, params);
  }
}
