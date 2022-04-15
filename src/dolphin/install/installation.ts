import { addGamePath, setSlippiSettings } from "@dolphin/config/config";
import { IniFile } from "@dolphin/config/iniFile";
import { findDolphinExecutable } from "@dolphin/util";
import { spawnSync } from "child_process";
import { app } from "electron";
import * as fs from "fs-extra";
import os from "os";
import path from "path";
import { lt } from "semver";

import { DolphinLaunchType } from "../types";
import { downloadLatestDolphin } from "./download";
import type { DolphinVersionResponse } from "./fetchLatestVersion";
import { fetchLatestVersion } from "./fetchLatestVersion";

const isLinux = process.platform === "linux";

export class DolphinInstallation {
  constructor(private dolphinLaunchType: DolphinLaunchType, private installationFolder: string) {}

  public get userFolder(): string {
    switch (process.platform) {
      case "win32": {
        return path.join(this.installationFolder, "User");
      }
      case "darwin": {
        return path.join(this.installationFolder, "Slippi Dolphin.app", "Contents", "Resources", "User");
      }
      case "linux": {
        const configPath = path.join(os.homedir(), ".config");
        const userFolderName = this.dolphinLaunchType === DolphinLaunchType.NETPLAY ? "SlippiOnline" : "SlippiPlayback";
        return path.join(configPath, userFolderName);
      }
      default:
        throw new Error(`Unsupported operating system: ${process.platform}`);
    }
  }

  public get sysFolder(): string {
    const dolphinPath = this.installationFolder;
    const type = this.dolphinLaunchType;
    switch (process.platform) {
      case "win32": {
        return path.join(dolphinPath, "Sys");
      }
      case "darwin": {
        return path.join(dolphinPath, "Slippi Dolphin.app", "Contents", "Resources", "Sys");
      }
      case "linux": {
        return path.join(app.getPath("userData"), type, "Sys");
      }
      default:
        throw new Error(`Unsupported operating system: ${process.platform}`);
    }
  }

  public async findDolphinExecutable(): Promise<string> {
    const dolphinPath = this.installationFolder;
    const type = this.dolphinLaunchType;

    return findDolphinExecutable(type, dolphinPath);
  }

  public async clearCache() {
    const cacheFolder = path.join(this.userFolder, "Cache");
    await fs.remove(cacheFolder);
  }

  public async importConfig(fromPath: string) {
    const newUserFolder = this.userFolder;
    await fs.ensureDir(this.userFolder);
    const oldUserFolder = path.join(fromPath, "User");

    if (!(await fs.pathExists(oldUserFolder))) {
      return;
    }

    await fs.copy(oldUserFolder, newUserFolder, { overwrite: true });
  }

  public async validate(log: (message: string) => void): Promise<void> {
    const type = this.dolphinLaunchType;
    const dolphinDownloadInfo = await fetchLatestVersion(type);

    try {
      await this.findDolphinExecutable();
      log(`Found existing ${type} Dolphin executable.`);
      log(`Checking if we need to update ${type} Dolphin`);
      const latestVersion = dolphinDownloadInfo.version;
      const isOutdated = await this._isOutOfDate(latestVersion);
      if (!isOutdated) {
        log("No update found...");
        return;
      }

      log(`${type} Dolphin installation is outdated. Downloading latest...`);
    } catch (err) {
      log(`Could not find ${type} Dolphin installation. Downloading...`);
    }

    // Start the download
    await this.downloadAndInstall({ releaseInfo: dolphinDownloadInfo, log });
  }

  public async downloadAndInstall({
    releaseInfo,
    log = console.log,
    cleanInstall,
  }: {
    releaseInfo?: DolphinVersionResponse;
    log?: (message: string) => void;
    cleanInstall?: boolean;
  }): Promise<void> {
    const type = this.dolphinLaunchType;
    let dolphinDownloadInfo = releaseInfo;
    if (!dolphinDownloadInfo) {
      dolphinDownloadInfo = await fetchLatestVersion(type);
    }

    const downloadUrl = dolphinDownloadInfo.downloadUrls[process.platform];
    if (!downloadUrl) {
      throw new Error(`Could not find latest Dolphin download url for ${process.platform}`);
    }

    const onProgress = (current: number, total: number) =>
      log(`Downloading... ${((current / total) * 100).toFixed(0)}%`);
    const downloadDir = path.join(app.getPath("userData"), "temp");
    const downloadedAsset = await downloadLatestDolphin(downloadUrl, downloadDir, onProgress, log);
    log(`Installing v${dolphinDownloadInfo.version} ${type} Dolphin...`);
    await this._installDolphin(downloadedAsset, log, cleanInstall);
    log(`Finished v${dolphinDownloadInfo.version} ${type} Dolphin install`);
  }

  public async addGamePath(gameDir: string): Promise<void> {
    const iniPath = path.join(this.userFolder, "Config", "Dolphin.ini");
    const iniFile = await IniFile.init(iniPath);
    await addGamePath(iniFile, gameDir);
  }

  public async updateSettings(options: Partial<{ useMonthlySubfolders: boolean; replayPath: string }>): Promise<void> {
    const iniPath = path.join(this.userFolder, "Config", "Dolphin.ini");
    const iniFile = await IniFile.init(iniPath);
    await setSlippiSettings(iniFile, options);
  }

  private async _isOutOfDate(latestVersion: string): Promise<boolean> {
    const dolphinPath = await this.findDolphinExecutable();
    const dolphinVersion = spawnSync(dolphinPath, ["--version"]).stdout.toString();
    return lt(dolphinVersion, latestVersion);
  }

  private async _uninstallDolphin() {
    await fs.remove(this.installationFolder);
    if (isLinux) {
      await fs.remove(this.userFolder);
    }
  }

  private async _installDolphin(assetPath: string, log: (message: string) => void, cleanInstall = false) {
    const dolphinPath = this.installationFolder;

    if (cleanInstall) {
      await this._uninstallDolphin();
    }

    switch (process.platform) {
      case "win32": {
        const { installDolphinOnWindows } = await import("./windows");
        await installDolphinOnWindows({ assetPath, destinationFolder: dolphinPath, log });
        break;
      }
      case "darwin": {
        const { installDolphinOnMac } = await import("./macos");
        await installDolphinOnMac({ assetPath, destinationFolder: dolphinPath, log });
        break;
      }
      case "linux": {
        const { installDolphinOnLinux } = await import("./linux");
        await installDolphinOnLinux({
          type: this.dolphinLaunchType,
          assetPath,
          destinationFolder: dolphinPath,
          log,
        });
        break;
      }
      default: {
        throw new Error(
          `Installing ${this.dolphinLaunchType} Dolphin is not supported on this platform: ${process.platform}`,
        );
      }
    }
  }
}