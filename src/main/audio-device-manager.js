/**
 * Audio Device Manager - Windows Default Audio Device Switching
 *
 * Automatically switches Windows default audio output when streaming starts
 * and restores the original device when streaming stops.
 *
 * Uses NirCmd (simple, reliable, no PowerShell needed)
 */

const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

// NirCmd is a tiny (47KB) command-line utility for Windows
// Download from: https://www.nirsoft.net/utils/nircmd.html
// We'll bundle it with the app
const NIRCMD_PATH = path.join(__dirname, '../../nircmd', 'nircmd.exe');

let originalAudioDevice = null;

/**
 * Get the current default audio device name using PowerShell (Windows 10/11)
 * WMIC is deprecated in Windows 11 24H2+, so we use Core Audio API via PowerShell
 */
function getCurrentAudioDevice() {
  return new Promise((resolve, reject) => {
    const os = require('os');
    const scriptPath = path.join(os.tmpdir(), 'get-audio-device.ps1');

    // PowerShell script using Core Audio API to get default playback device name
    const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid id, int clsCtx, int activationParams, out IntPtr ptr);
    int OpenPropertyStore(int access, out IPropertyStore props);
    int GetId(out IntPtr id);
    int GetState(out int state);
}

[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore {
    int GetCount(out int count);
    int GetAt(int index, out PROPERTYKEY key);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT propvar);
    int SetValue(ref PROPERTYKEY key, ref PROPVARIANT propvar);
    int Commit();
}

[StructLayout(LayoutKind.Sequential)]
public struct PROPERTYKEY {
    public Guid fmtid;
    public int pid;
}

[StructLayout(LayoutKind.Sequential)]
public struct PROPVARIANT {
    public short vt;
    public short r1;
    public short r2;
    public short r3;
    public IntPtr val1;
    public IntPtr val2;
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumerator {}

public static class AudioDevice {
    public static string GetDefaultPlayback() {
        var enumerator = new MMDeviceEnumerator() as IMMDeviceEnumerator;
        IMMDevice device;
        enumerator.GetDefaultAudioEndpoint(0, 1, out device);
        IPropertyStore props;
        device.OpenPropertyStore(0, out props);
        PROPERTYKEY key = new PROPERTYKEY();
        key.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
        key.pid = 14;
        PROPVARIANT value;
        props.GetValue(ref key, out value);
        return Marshal.PtrToStringUni(value.val1);
    }
}
"@
[AudioDevice]::GetDefaultPlayback()
`;

    try {
      fs.writeFileSync(scriptPath, psScript, 'utf8');
    } catch (e) {
      console.error('[AudioDeviceManager] Failed to write script:', e.message);
      reject(new Error('Failed to write PowerShell script'));
      return;
    }

    exec(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
      { timeout: 10000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          console.error('[AudioDeviceManager] PowerShell error:', stderr || error.message);
          reject(new Error('Could not determine current audio device'));
        } else {
          const deviceName = stdout.trim();
          if (deviceName) {
            console.log(`[AudioDeviceManager] Current device: ${deviceName}`);
            resolve(deviceName);
          } else {
            reject(new Error('Empty device name returned'));
          }
        }
      }
    );
  });
}

/**
 * Set Windows default audio playback device
 * Uses NirCmd if available, otherwise falls back to PowerShell with AudioDeviceCmdlets
 * @param {string} deviceName - Name of the audio device
 */
function setDefaultAudioDevice(deviceName) {
  return new Promise((resolve, reject) => {
    console.log(`[AudioDeviceManager] setDefaultAudioDevice called with: "${deviceName}"`);
    console.log(`[AudioDeviceManager] NirCmd path: ${NIRCMD_PATH}`);
    console.log(`[AudioDeviceManager] NirCmd exists: ${fs.existsSync(NIRCMD_PATH)}`);

    // Try NirCmd first (faster)
    if (fs.existsSync(NIRCMD_PATH)) {
      const args = ['setdefaultsounddevice', deviceName, '1'];
      console.log(`[AudioDeviceManager] Running: nircmd ${args.join(' ')}`);
      const process = spawn(NIRCMD_PATH, args, {
        windowsHide: true,
        stdio: 'pipe'
      });

      let errorOutput = '';
      let stdoutOutput = '';

      process.stdout.on('data', (data) => {
        stdoutOutput += data.toString();
      });

      process.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      process.on('close', (code) => {
        console.log(`[AudioDeviceManager] NirCmd exit code: ${code}`);
        if (stdoutOutput) console.log(`[AudioDeviceManager] NirCmd stdout: ${stdoutOutput}`);
        if (errorOutput) console.log(`[AudioDeviceManager] NirCmd stderr: ${errorOutput}`);

        if (code === 0) {
          console.log(`[AudioDeviceManager] SUCCESS: Switched to "${deviceName}" via NirCmd`);
          resolve();
        } else {
          // NirCmd failed, try PowerShell fallback
          console.log(`[AudioDeviceManager] NirCmd failed (code ${code}), trying PowerShell...`);
          setDefaultAudioDevicePowerShell(deviceName).then(resolve).catch(reject);
        }
      });

      process.on('error', (err) => {
        console.log(`[AudioDeviceManager] NirCmd error: ${err.message}, trying PowerShell...`);
        setDefaultAudioDevicePowerShell(deviceName).then(resolve).catch(reject);
      });
    } else {
      // NirCmd not found, use PowerShell
      console.log('[AudioDeviceManager] NirCmd not found at path, using PowerShell fallback');
      setDefaultAudioDevicePowerShell(deviceName).then(resolve).catch(reject);
    }
  });
}

/**
 * Set default audio device using PowerShell
 * Uses PolicyConfig COM interface (works on Windows 10/11)
 */
function setDefaultAudioDevicePowerShell(deviceName) {
  return new Promise((resolve, reject) => {
    const os = require('os');
    const scriptPath = path.join(os.tmpdir(), 'set-audio-device.ps1');

    // PowerShell script using PolicyConfig COM interface
    const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPolicyConfig {
    int GetMixFormat(string deviceId, IntPtr format);
    int GetDeviceFormat(string deviceId, int flow, IntPtr format);
    int ResetDeviceFormat(string deviceId);
    int SetDeviceFormat(string deviceId, IntPtr format1, IntPtr format2);
    int GetProcessingPeriod(string deviceId, int flow, out long defaultPeriod, out long minPeriod);
    int SetProcessingPeriod(string deviceId, long period);
    int GetShareMode(string deviceId, out int mode);
    int SetShareMode(string deviceId, int mode);
    int GetPropertyValue(string deviceId, int stgmAccess, IntPtr key, out IntPtr variant);
    int SetPropertyValue(string deviceId, int stgmAccess, IntPtr key, IntPtr variant);
    int SetDefaultEndpoint(string deviceId, int role);
    int SetEndpointVisibility(string deviceId, int visible);
}

[ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
class PolicyConfig {}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid id, int clsCtx, int activationParams, out IntPtr ptr);
    int OpenPropertyStore(int access, out IPropertyStore props);
    int GetId(out IntPtr id);
    int GetState(out int state);
}

[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection {
    int GetCount(out int count);
    int Item(int index, out IMMDevice device);
}

[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore {
    int GetCount(out int count);
    int GetAt(int index, out PROPERTYKEY key);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT propvar);
    int SetValue(ref PROPERTYKEY key, ref PROPVARIANT propvar);
    int Commit();
}

[StructLayout(LayoutKind.Sequential)]
public struct PROPERTYKEY {
    public Guid fmtid;
    public int pid;
}

[StructLayout(LayoutKind.Sequential)]
public struct PROPVARIANT {
    public short vt;
    public short r1, r2, r3;
    public IntPtr val1, val2;
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumerator {}

public static class AudioSwitcher {
    public static bool SetDefault(string targetName) {
        var enumerator = new MMDeviceEnumerator() as IMMDeviceEnumerator;
        IMMDeviceCollection devices;
        enumerator.EnumAudioEndpoints(0, 1, out devices);

        int count;
        devices.GetCount(out count);

        for (int i = 0; i < count; i++) {
            IMMDevice device;
            devices.Item(i, out device);

            IPropertyStore props;
            device.OpenPropertyStore(0, out props);

            PROPERTYKEY key = new PROPERTYKEY();
            key.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
            key.pid = 14;

            PROPVARIANT value;
            props.GetValue(ref key, out value);
            string name = Marshal.PtrToStringUni(value.val1);

            if (name != null && name.ToLower().Contains(targetName.ToLower())) {
                IntPtr idPtr;
                device.GetId(out idPtr);
                string id = Marshal.PtrToStringUni(idPtr);

                var policy = new PolicyConfig() as IPolicyConfig;
                policy.SetDefaultEndpoint(id, 0); // eConsole
                policy.SetDefaultEndpoint(id, 1); // eMultimedia
                policy.SetDefaultEndpoint(id, 2); // eCommunications
                return true;
            }
        }
        return false;
    }
}
"@

\$result = [AudioSwitcher]::SetDefault("${deviceName.replace(/"/g, '`"')}")
if (\$result) { Write-Output "OK" } else { Write-Output "NOTFOUND" }
`;

    try {
      fs.writeFileSync(scriptPath, psScript, 'utf8');
    } catch (e) {
      reject(new Error('Failed to write PowerShell script'));
      return;
    }

    exec(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
      { timeout: 15000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          console.error('[AudioDeviceManager] PowerShell switch error:', stderr || error.message);
          reject(new Error(`Failed to switch audio device: ${stderr || error.message}`));
        } else {
          const result = stdout.trim();
          if (result === 'OK') {
            console.log(`[AudioDeviceManager] Switched to (PowerShell): ${deviceName}`);
            resolve();
          } else if (result === 'NOTFOUND') {
            reject(new Error(`Audio device not found: ${deviceName}`));
          } else {
            reject(new Error(`Unexpected result: ${result}`));
          }
        }
      }
    );
  });
}

/**
 * Switch to streaming audio device (virtual-audio-capturer)
 * Saves the current device for later restoration
 */
async function switchToStreamingDevice() {
  try {
    // Save current device
    originalAudioDevice = await getCurrentAudioDevice();
    console.log(`[AudioDeviceManager] Original device: ${originalAudioDevice}`);

    // Switch to virtual audio device
    // Note: The exact device name might vary - we'll try common names
    // Windows shows devices as "[Name] (Description)" - partial match works
    const virtualDeviceNames = [
      'Virtual Desktop Audio',           // Most common - screen-capture-recorder
      'virtual-audio-capturer',          // Legacy name
      'Virtual Audio Capturer',          // Case variant
      'Speakers (Virtual Desktop Audio)', // Full name with prefix
      'CABLE Input',                      // VB-Audio CABLE
      'VB-Audio Virtual Cable'            // VB-Audio alternative
    ];

    let switched = false;
    let triedNames = [];
    for (const deviceName of virtualDeviceNames) {
      try {
        console.log(`[AudioDeviceManager] Trying device: ${deviceName}`);
        await setDefaultAudioDevice(deviceName);
        console.log(`[AudioDeviceManager] Successfully switched to: ${deviceName}`);
        switched = true;
        break;
      } catch (err) {
        triedNames.push(deviceName);
        console.log(`[AudioDeviceManager] Device not found: ${deviceName}`);
        continue;
      }
    }

    if (!switched) {
      console.error(`[AudioDeviceManager] Tried devices: ${triedNames.join(', ')}`);
      throw new Error('Could not find virtual audio device. Please ensure screen-capture-recorder or VB-CABLE is installed. Tried: ' + triedNames.join(', '));
    }

    return { success: true, originalDevice: originalAudioDevice };
  } catch (error) {
    console.error('[AudioDeviceManager] Failed to switch to streaming device:', error);
    throw error;
  }
}

/**
 * Restore the original audio device
 */
async function restoreOriginalDevice() {
  if (!originalAudioDevice) {
    console.log('[AudioDeviceManager] No original device to restore');
    return { success: false, message: 'No original device saved' };
  }

  try {
    await setDefaultAudioDevice(originalAudioDevice);
    console.log(`[AudioDeviceManager] Restored original device: ${originalAudioDevice}`);
    originalAudioDevice = null;
    return { success: true };
  } catch (error) {
    console.error('[AudioDeviceManager] Failed to restore original device:', error);
    throw error;
  }
}

module.exports = {
  switchToStreamingDevice,
  restoreOriginalDevice,
  getCurrentAudioDevice,
  setDefaultAudioDevice
};
