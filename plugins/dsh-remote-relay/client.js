window.__ModuleLoader__.load({
  id: '@pcmid/dsh-remote-relay',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const UI = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    const { useEffect, useMemo, useRef, useState } = React;

    const NS = 'settings.remoteRelay';
    const NAMESPACE = 'remote-relay';
    const CHANNEL = '/api';
    const ENDPOINT = 'pcmid/remote-relay';
    const PREFIX = 'dsh-rr';
    const POLL_MS = 2000;
    const NOTICE_MS = 1600;
    /** postMessage channel between a device view and the DSH window that embeds it. */
    const BRIDGE = 'dsh-remote-relay';
    const BRIDGE_VERSION = 1;
    /** Window attributes a device view mirrors so it lays out for the same window chrome. */
    const MIRRORED_ATTRIBUTES = ['data-platform', 'data-fullscreen'];
    const CURRENT_KEY = 'dsh-remote-relay:current';
    /** DSH's own persisted main selection (ui-workspace); read to learn which Session this window shows. */
    const SELECTION_KEY = 'dsh.sessions.current';

    const zh = {
      nav: '远程访问',
      lead: '在几台装有本插件的 DSH 之间切换，或从手机使用这台 DSH。数据经自建的 OpenChamber relay 端到端加密，relay 只转发密文。',
      hostHeading: '让其他设备访问本机',
      hostIntro: '开启后，配对过的设备可以通过 relay 使用这台 DSH，本机不需要开放端口。',
      enable: '开启远程访问',
      enableTip: '开启后，DSH 会保持与 relay 的连接，已配对的设备可以随时连进来。',
      status: '状态',
      relay: 'Relay 地址',
      relayTip: '自建 relay 的 WebSocket 地址，例如 wss://relay.example.com/ws。只写域名时会自动补全。',
      relayPlaceholder: 'wss://relay.example.com/ws',
      launcher: '手机启动页地址',
      launcherTip: '部署了本插件 launcher 目录的 HTTPS 地址，手机扫码后打开它。只用另一台 DSH 访问时不用填。',
      launcherPlaceholder: 'https://remote.example.com/',
      hostName: '本机名称',
      hostNameTip: '其他设备切换列表里显示的名称。',
      save: '保存',
      saved: '已保存',
      saveFailed: '保存失败',
      pairHeading: '配对新设备',
      pairIntro: '生成一次性配对链接，发到要访问本机的设备上。链接只能使用一次。',
      pairAction: '生成配对链接',
      pairNeedsOnline: '开启访问并连上 relay 后才能配对。',
      pairLink: '配对链接',
      pairLinkTip: '在另一台装有本插件的 DSH 上，点侧边栏底部的设备按钮 →「添加设备」，粘贴此链接。',
      scan: '手机扫码打开',
      copy: '复制',
      copied: '已复制',
      expiresIn: '{time} 后失效',
      cancel: '取消',
      risk: '配对后的设备拥有与你在本机相同的全部权限，包括执行命令和读写文件。只配对你自己的设备；不再使用时请移除。',
      devices: '可以访问本机的设备',
      noDevices: '还没有配对的设备。',
      online: '已连接',
      pairedAt: '配对于 {date}',
      lastSeen: '最近使用 {time}',
      remove: '移除',
      confirmRemove: '确认移除',
      hostId: '本机 ID',
      loadFailed: '读取远程访问状态失败',
      retry: '重试',
      state_starting: '正在启动',
      state_disabled: '已关闭',
      state_unconfigured: '需要填写 relay 地址',
      state_connecting: '正在连接 relay',
      state_online: '在线',
      state_offline: '离线',
      state_replaced: '已被另一个 DSH 接管',
      state_error: '出错',
      onlineDetail: '已连接 relay，{count} 台设备在线',
      removing: '正在移除…',
      removeDevice: '移除设备',
      removeTitle: '移除 {name}？',
      removeIntro: '移除后不能再切换到 {name}，它也会同时把本机从它的设备列表里删掉。之后要重新配对才能再用。',
      removedTitle: '已移除 {name}',
      removeUnconfirmed: '已从本机移除 {name}。没能连上它，它的设备列表里可能还留着本机；这条记录已经不能用来访问，可以在它的「设置 → 远程访问」里移除。',
      removeFailed: '移除失败：{error}',
      gotIt: '知道了',
      // Device switcher
      switcher: '切换设备',
      thisDevice: '本机',
      remoteTag: '远程',
      devicesMenu: '设备',
      addDevice: '添加设备…',
      addTitle: '添加设备',
      addIntro: '在另一台装有本插件的 DSH 上打开「设置 → 远程访问」，点「生成配对链接」，复制后粘贴到这里。',
      linkLabel: '配对链接',
      linkPlaceholder: '粘贴配对链接',
      linkPreview: '{host} · {time} 前有效',
      linkInvalid: '这不是完整的配对链接。',
      linkExpired: '这个配对链接已过期，请在对方重新生成。',
      nameLabel: '本机在对方显示为',
      addRisk: '添加后，本机可以完全控制那台 DSH，包括执行命令和读写文件。',
      addAction: '添加并切换',
      adding: '正在配对…',
      close: '关闭',
      connectingTo: '正在连接 {name}…',
      cannotReach: '无法连接 {name}',
      removedBy: '{name} 已移除本机',
      device_connected: '已连接',
      device_connecting: '正在连接…',
      device_connecting_cancel: '正在连接… 点按取消',
      device_retrying: '无法连接',
      device_rejected: '已移除本机，需重新添加',
      device_idle: '',
      readdDevice: '重新添加',
      err_pairing_invalid: '配对链接无效、已使用或已过期，请在对方重新生成。',
      err_self: '这是本机自己的配对链接，请在另一台 DSH 上生成。',
      err_unreachable: '连不上对方：{error}',
      err_timeout: '对方没有响应。请确认那台 DSH 正在运行，并且远程访问显示「在线」。',
      err_offline: '对方离线或没有响应',
      err_relay: '连不上 relay',
      err_host_key: '对方的身份和配对时不一致，请重新添加',
      retryHint: '{reason} · 点按重试',
      readdHint: '已移除本机 · 点按重新添加',
    };
    const en = {
      nav: 'Remote access',
      lead: 'Switch between DSH hosts that have this plugin, or use this DSH from a phone. Traffic is end-to-end encrypted through your self-hosted OpenChamber relay, which only forwards ciphertext.',
      hostHeading: 'Let other devices reach this DSH',
      hostIntro: 'While on, paired devices can use this DSH through the relay; no port is opened on this computer.',
      enable: 'Turn on remote access',
      enableTip: 'While on, DSH stays connected to the relay so paired devices can reach it at any time.',
      status: 'Status',
      relay: 'Relay address',
      relayTip: 'WebSocket address of your relay, such as wss://relay.example.com/ws. A bare host name is completed automatically.',
      relayPlaceholder: 'wss://relay.example.com/ws',
      launcher: 'Phone launcher address',
      launcherTip: 'HTTPS address where this plugin\'s launcher folder is deployed; phones open it from the QR code. Not needed when only another DSH connects.',
      launcherPlaceholder: 'https://remote.example.com/',
      hostName: 'Name of this DSH',
      hostNameTip: 'Shown in the device list of other devices.',
      save: 'Save',
      saved: 'Saved',
      saveFailed: 'Could not save',
      pairHeading: 'Pair a device',
      pairIntro: 'Create a one-time pairing link and send it to the device that should reach this DSH. A link works once.',
      pairAction: 'Create pairing link',
      pairNeedsOnline: 'Turn on access and connect to the relay before pairing.',
      pairLink: 'Pairing link',
      pairLinkTip: 'On another DSH with this plugin, choose the device button at the bottom of the sidebar → Add device, and paste this link.',
      scan: 'Scan with your phone',
      copy: 'Copy',
      copied: 'Copied',
      expiresIn: 'Expires in {time}',
      cancel: 'Cancel',
      risk: 'A paired device has the same full authority you have on this computer, including running commands and changing files. Pair only devices you own, and remove them when unused.',
      devices: 'Devices that can reach this DSH',
      noDevices: 'No devices are paired yet.',
      online: 'Connected',
      pairedAt: 'Paired {date}',
      lastSeen: 'Last used {time}',
      remove: 'Remove',
      confirmRemove: 'Confirm removal',
      hostId: 'Host ID',
      loadFailed: 'Could not read the remote access status',
      retry: 'Retry',
      state_starting: 'Starting',
      state_disabled: 'Off',
      state_unconfigured: 'Relay address needed',
      state_connecting: 'Connecting to the relay',
      state_online: 'Online',
      state_offline: 'Offline',
      state_replaced: 'Taken over by another DSH',
      state_error: 'Error',
      onlineDetail: 'Connected to the relay, {count} device(s) online',
      removing: 'Removing…',
      removeDevice: 'Remove device',
      removeTitle: 'Remove {name}?',
      removeIntro: 'You can no longer switch to {name}, and it also removes this DSH from its device list. Pair again to use it later.',
      removedTitle: '{name} removed',
      removeUnconfirmed: '{name} was removed here. It could not be reached, so it may still list this DSH; that entry can no longer be used for access, and you can remove it under its Settings → Remote access.',
      removeFailed: 'Could not remove it: {error}',
      gotIt: 'Got it',
      switcher: 'Switch device',
      thisDevice: 'This device',
      remoteTag: 'Remote',
      devicesMenu: 'Devices',
      addDevice: 'Add device…',
      addTitle: 'Add device',
      addIntro: 'On another DSH with this plugin, open Settings → Remote access, choose Create pairing link, and paste the link here.',
      linkLabel: 'Pairing link',
      linkPlaceholder: 'Paste the pairing link',
      linkPreview: '{host} · valid until {time}',
      linkInvalid: 'This is not a complete pairing link.',
      linkExpired: 'This pairing link has expired. Create a new one on the other DSH.',
      nameLabel: 'Name of this DSH over there',
      addRisk: 'Once added, this DSH has full control of that DSH, including running commands and changing files.',
      addAction: 'Add and switch',
      adding: 'Pairing…',
      close: 'Close',
      connectingTo: 'Connecting to {name}…',
      cannotReach: 'Cannot reach {name}',
      removedBy: '{name} removed this DSH',
      device_connected: 'Connected',
      device_connecting: 'Connecting…',
      device_connecting_cancel: 'Connecting… choose to cancel',
      device_retrying: 'Unreachable',
      device_rejected: 'Removed this DSH; add it again',
      device_idle: '',
      readdDevice: 'Add again',
      err_pairing_invalid: 'The pairing link is invalid, used, or expired. Create a new one on the other DSH.',
      err_self: 'This pairing link belongs to this DSH. Create one on the other DSH.',
      err_unreachable: 'Cannot reach the other DSH: {error}',
      err_timeout: 'The other DSH did not answer. Make sure it is running and its remote access shows Online.',
      err_offline: 'Offline or not answering',
      err_relay: 'Cannot reach the relay',
      err_host_key: 'Its identity changed since pairing; add it again',
      retryHint: '{reason} · choose to retry',
      readdHint: 'Removed this DSH · choose to add it again',
    };

    // -----------------------------------------------------------------------
    // QR code encoder (byte mode, error correction level M, versions 1-40)
    // -----------------------------------------------------------------------

    const ECC_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
    const BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
    const FORMAT_BITS_M = 0;

    function rawDataModules(ver) {
      let result = (16 * ver + 128) * ver + 64;
      if (ver >= 2) {
        const align = Math.floor(ver / 7) + 2;
        result -= (25 * align - 10) * align - 55;
        if (ver >= 7) result -= 36;
      }
      return result;
    }

    function dataCodewords(ver) {
      return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK_M[ver] * BLOCKS_M[ver];
    }

    function gfMultiply(x, y) {
      let z = 0;
      for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        z ^= ((y >>> i) & 1) * x;
      }
      return z;
    }

    function rsDivisor(degree) {
      const result = new Array(degree).fill(0);
      result[degree - 1] = 1;
      let root = 1;
      for (let i = 0; i < degree; i++) {
        for (let j = 0; j < result.length; j++) {
          result[j] = gfMultiply(result[j], root);
          if (j + 1 < result.length) result[j] ^= result[j + 1];
        }
        root = gfMultiply(root, 0x02);
      }
      return result;
    }

    function rsRemainder(data, divisor) {
      const result = divisor.map(() => 0);
      for (const b of data) {
        const factor = b ^ result.shift();
        result.push(0);
        divisor.forEach((coef, i) => { result[i] ^= gfMultiply(coef, factor); });
      }
      return result;
    }

    function alignmentPositions(ver, size) {
      if (ver === 1) return [];
      const count = Math.floor(ver / 7) + 2;
      const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2;
      const result = [6];
      for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
      return result;
    }

    /** Encode text as a QR matrix; returns rows of booleans (true = dark). */
    function encodeQr(text) {
      const bytes = Array.from(new TextEncoder().encode(text));
      let ver = 1;
      for (; ver <= 40; ver++) {
        const bits = 4 + (ver < 10 ? 8 : 16) + bytes.length * 8;
        if (bits <= dataCodewords(ver) * 8) break;
      }
      if (ver > 40) throw new Error('text too long for a QR code');
      const capacity = dataCodewords(ver) * 8;
      const bitList = [];
      const push = (value, length) => { for (let i = length - 1; i >= 0; i--) bitList.push((value >>> i) & 1); };
      push(4, 4);
      push(bytes.length, ver < 10 ? 8 : 16);
      for (const b of bytes) push(b, 8);
      push(0, Math.min(4, capacity - bitList.length));
      push(0, (8 - bitList.length % 8) % 8);
      for (let pad = 0xec; bitList.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
      const data = [];
      for (let i = 0; i < bitList.length; i += 8) data.push(bitList.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));

      const blockCount = BLOCKS_M[ver];
      const eccLength = ECC_PER_BLOCK_M[ver];
      const rawCodewords = Math.floor(rawDataModules(ver) / 8);
      const shortCount = blockCount - rawCodewords % blockCount;
      const shortLength = Math.floor(rawCodewords / blockCount);
      const divisor = rsDivisor(eccLength);
      const blocks = [];
      for (let i = 0, k = 0; i < blockCount; i++) {
        const chunk = data.slice(k, k + shortLength - eccLength + (i < shortCount ? 0 : 1));
        k += chunk.length;
        const ecc = rsRemainder(chunk, divisor);
        if (i < shortCount) chunk.push(0);
        blocks.push(chunk.concat(ecc));
      }
      const codewords = [];
      for (let i = 0; i < blocks[0].length; i++) {
        blocks.forEach((block, j) => {
          if (i !== shortLength - eccLength || j >= shortCount) codewords.push(block[i]);
        });
      }

      const size = ver * 4 + 17;
      const modules = Array.from({ length: size }, () => new Array(size).fill(false));
      const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
      const setFixed = (x, y, dark) => { modules[y][x] = dark; fixed[y][x] = true; };
      for (let i = 0; i < size; i++) {
        setFixed(6, i, i % 2 === 0);
        setFixed(i, 6, i % 2 === 0);
      }
      for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
        for (let dy = -4; dy <= 4; dy++) {
          for (let dx = -4; dx <= 4; dx++) {
            const x = cx + dx;
            const y = cy + dy;
            if (x < 0 || x >= size || y < 0 || y >= size) continue;
            const dist = Math.max(Math.abs(dx), Math.abs(dy));
            setFixed(x, y, dist !== 2 && dist !== 4);
          }
        }
      }
      const align = alignmentPositions(ver, size);
      for (let i = 0; i < align.length; i++) {
        for (let j = 0; j < align.length; j++) {
          if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) setFixed(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
      const drawFormat = (mask) => {
        const value = (FORMAT_BITS_M << 3) | mask;
        let rem = value;
        for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        const bits = ((value << 10) | rem) ^ 0x5412;
        const bit = (i) => ((bits >>> i) & 1) !== 0;
        for (let i = 0; i <= 5; i++) setFixed(8, i, bit(i));
        setFixed(8, 7, bit(6));
        setFixed(8, 8, bit(7));
        setFixed(7, 8, bit(8));
        for (let i = 9; i < 15; i++) setFixed(14 - i, 8, bit(i));
        for (let i = 0; i < 8; i++) setFixed(size - 1 - i, 8, bit(i));
        for (let i = 8; i < 15; i++) setFixed(8, size - 15 + i, bit(i));
        setFixed(8, size - 8, true);
      };
      drawFormat(0);
      if (ver >= 7) {
        let rem = ver;
        for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
        const bits = (ver << 12) | rem;
        for (let i = 0; i < 18; i++) {
          const dark = ((bits >>> i) & 1) !== 0;
          const a = size - 11 + i % 3;
          const b = Math.floor(i / 3);
          setFixed(a, b, dark);
          setFixed(b, a, dark);
        }
      }
      let index = 0;
      for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) {
          for (let j = 0; j < 2; j++) {
            const x = right - j;
            const upward = ((right + 1) & 2) === 0;
            const y = upward ? size - 1 - vert : vert;
            if (!fixed[y][x] && index < codewords.length * 8) {
              modules[y][x] = ((codewords[index >>> 3] >>> (7 - (index & 7))) & 1) !== 0;
              index++;
            }
          }
        }
      }
      const masks = [
        (x, y) => (x + y) % 2 === 0,
        (x, y) => y % 2 === 0,
        (x) => x % 3 === 0,
        (x, y) => (x + y) % 3 === 0,
        (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
        (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
        (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
        (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
      ];
      const applyMask = (mask) => {
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) if (!fixed[y][x] && masks[mask](x, y)) modules[y][x] = !modules[y][x];
        }
      };
      const penalty = () => {
        let score = 0;
        const lines = [];
        for (let y = 0; y < size; y++) lines.push(modules[y].map(Number).join(''));
        for (let x = 0; x < size; x++) lines.push(modules.map((row) => Number(row[x])).join(''));
        for (const line of lines) {
          for (const run of line.match(/0{5,}|1{5,}/g) ?? []) score += run.length - 2;
          for (let i = line.indexOf('1011101'); i >= 0; i = line.indexOf('1011101', i + 1)) {
            if (line.slice(Math.max(0, i - 4), i) === '0000' || line.slice(i + 7, i + 11) === '0000') score += 40;
          }
        }
        let dark = 0;
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            if (modules[y][x]) dark++;
            if (x < size - 1 && y < size - 1) {
              const c = modules[y][x];
              if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
            }
          }
        }
        score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
        return score;
      };
      let best = 0;
      let bestScore = Infinity;
      for (let mask = 0; mask < 8; mask++) {
        applyMask(mask);
        drawFormat(mask);
        const score = penalty();
        if (score < bestScore) {
          best = mask;
          bestScore = score;
        }
        applyMask(mask);
      }
      applyMask(best);
      drawFormat(best);
      return modules;
    }

    function QrCode({ text, label }) {
      const path = useMemo(() => {
        try {
          const modules = encodeQr(text);
          let d = '';
          modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x + 4} ${y + 4}h1v1h-1z`; }));
          return { d, size: modules.length + 8 };
        } catch {
          return undefined;
        }
      }, [text]);
      if (path === undefined) return null;
      // A QR code needs dark modules on a light field in both themes, so it uses literal colors.
      return h('svg', {
        className: `${PREFIX}-qr`,
        viewBox: `0 0 ${path.size} ${path.size}`,
        role: 'img',
        'aria-label': label,
        shapeRendering: 'crispEdges',
      }, h('rect', { width: path.size, height: path.size, fill: '#ffffff' }), h('path', { d: path.d, fill: '#000000' }));
    }


    // -----------------------------------------------------------------------
    // Styles
    // -----------------------------------------------------------------------

    const CSS = `
.${PREFIX}-root { display: flex; flex-direction: column; width: 100%; color: var(--dsw-alias-label-primary); }
.${PREFIX}-lead { margin: 0 0 4px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.${PREFIX}-group { display: flex; flex-direction: column; padding: 8px 0 12px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.${PREFIX}-group:last-of-type { border-bottom: none; }
.${PREFIX}-heading { margin: 12px 0 4px; font-size: 14px; font-weight: 500; line-height: 20px; }
.${PREFIX}-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 24px; padding: 12px 0; }
.${PREFIX}-label { flex: 1 1 220px; min-width: 0; }
.${PREFIX}-title { font-size: 14px; line-height: 20px; }
.${PREFIX}-desc { margin-top: 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.${PREFIX}-control { flex: 1 1 280px; min-width: 0; display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.${PREFIX}-switch { box-sizing: border-box; position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px; background: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); cursor: pointer; }
.${PREFIX}-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); }
.${PREFIX}-switch:disabled { cursor: default; opacity: 0.5; }
.${PREFIX}-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.${PREFIX}-thumb { display: block; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-label-primary-foreground, #fff); transition: transform 120ms ease; }
.${PREFIX}-switch[aria-checked="false"] .${PREFIX}-thumb { background: var(--dsw-alias-switch-thumb, #fff); }
.${PREFIX}-switch[aria-checked="true"] .${PREFIX}-thumb { transform: translateX(16px); }
.${PREFIX}-input { box-sizing: border-box; flex: 1 1 auto; min-width: 0; max-width: 360px; height: 32px; padding: 0 10px; border: 0.5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-1); font: inherit; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); outline: none; }
.${PREFIX}-input:focus { border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); }
.${PREFIX}-input::placeholder { color: var(--dsw-alias-label-dimmed, var(--dsw-alias-label-secondary)); }
.${PREFIX}-input[readonly] { color: var(--dsw-alias-label-secondary); }
.${PREFIX}-mono { font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; }
.${PREFIX}-button { box-sizing: border-box; flex: none; display: inline-flex; align-items: center; justify-content: center; height: 32px; padding: 0 12px; border: 0.5px solid transparent; border-radius: var(--dsw-radius-md, 8px); background: transparent; box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); font: inherit; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); cursor: pointer; white-space: nowrap; }
.${PREFIX}-button[data-primary] { box-shadow: none; background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-label-primary)); color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-layer-1)); }
.${PREFIX}-button[data-danger] { color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-button[data-size="small"] { height: 26px; padding: 0 10px; font-size: 12px; }
.${PREFIX}-button:disabled { opacity: 0.4; cursor: not-allowed; }
.${PREFIX}-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
@media (hover: hover) { .${PREFIX}-button:hover:not(:disabled):not([data-primary]) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); } }
.${PREFIX}-state { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; line-height: 20px; }
.${PREFIX}-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--dsw-alias-state-idle-primary); }
.${PREFIX}-dot[data-tone="ok"] { background: var(--dsw-alias-state-success-primary); }
.${PREFIX}-dot[data-tone="warn"] { background: var(--dsw-alias-state-warn-primary); }
.${PREFIX}-dot[data-tone="error"] { background: var(--dsw-alias-state-error-primary); }
.${PREFIX}-status { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.${PREFIX}-status[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-error { margin: 4px 0 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.${PREFIX}-note { margin: 8px 0 4px; padding: 8px 12px; border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-2); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.${PREFIX}-pairing { display: flex; flex-wrap: wrap; gap: 16px 24px; align-items: flex-start; padding: 8px 0; }
.${PREFIX}-qr-box { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.${PREFIX}-qr { width: 152px; height: 152px; border-radius: var(--dsw-radius-md, 8px); }
.${PREFIX}-fields { flex: 1 1 280px; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.${PREFIX}-field { display: flex; flex-direction: column; gap: 6px; }
.${PREFIX}-field-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.${PREFIX}-copy-row { display: flex; gap: 8px; align-items: center; }
.${PREFIX}-countdown { font-variant-numeric: tabular-nums; }
.${PREFIX}-copy-row .${PREFIX}-input { max-width: none; }
.${PREFIX}-device { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l1, var(--dsw-alias-border-l2)); }
.${PREFIX}-device:last-child { border-bottom: none; }
.${PREFIX}-device-main { flex: 1; min-width: 0; }
.${PREFIX}-device-name { display: flex; align-items: center; gap: 8px; font-size: 14px; line-height: 20px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${PREFIX}-badge { flex: none; padding: 0 6px; border-radius: 999px; font-size: 11px; line-height: 18px; color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent); }
.${PREFIX}-badge[data-tone="error"] { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.${PREFIX}-badge[data-tone="neutral"] { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.${PREFIX}-footer { padding: 12px 0 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
@media (prefers-reduced-motion: reduce) { .${PREFIX}-thumb { transition: none; } }

/* Device switcher trigger: the same row geometry as the Settings trigger below it. */
.${PREFIX}-sw { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--dsh-sidebar-label-gap, 8px); height: 42px; margin: 4px 0 0; padding: 0 calc(var(--dsh-sidebar-row-padding, 12px) - var(--dsh-sidebar-paint-inset, 0px)); box-sizing: border-box; border: none; border-inline: var(--dsh-sidebar-paint-inset, 0px) solid transparent; background: transparent; background-clip: padding-box; border-radius: var(--dsw-radius-md, 8px); color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px; text-align: start; cursor: pointer; overflow: hidden; }
.${PREFIX}-sw[data-rail] { flex: none; width: 36px; height: 36px; margin: 8px 0 0; padding: 0; justify-content: center; gap: 0; border-inline: 0; background-clip: border-box; }
.${PREFIX}-sw[aria-expanded="true"] { background-color: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
@media (hover: hover) { .${PREFIX}-sw:hover { background-color: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); } }
.${PREFIX}-sw:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.${PREFIX}-sw-icon { position: relative; flex: none; display: inline-flex; color: var(--dsw-alias-label-primary); }
.${PREFIX}-sw-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${PREFIX}-sw[data-tone="error"] .${PREFIX}-sw-label { color: var(--dsw-alias-label-primary); }
.${PREFIX}-sw-tag { flex: none; padding: 0 6px; border-radius: 999px; font-size: 11px; line-height: 18px; color: var(--dsw-alias-label-secondary); box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); }
.${PREFIX}-sw-chevron { flex: none; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.${PREFIX}-pip { position: absolute; right: -2px; bottom: -1px; width: 6px; height: 6px; border-radius: 50%; box-shadow: 0 0 0 1.5px var(--dsw-alias-bg-base, #fff); background: var(--dsw-alias-state-success-primary); }
.${PREFIX}-pip[data-tone="warn"] { background: var(--dsw-alias-state-warn-primary); }
.${PREFIX}-pip[data-tone="error"] { background: var(--dsw-alias-state-error-primary); }
.${PREFIX}-spin { animation: ${PREFIX}-spin 0.9s linear infinite; }
@keyframes ${PREFIX}-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .${PREFIX}-spin { animation-duration: 2.4s; } }

/* Menu rows */
.${PREFIX}-mrow { display: flex; align-items: center; gap: 12px; min-width: 216px; }
.${PREFIX}-mname { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.${PREFIX}-mname > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${PREFIX}-mmeta { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${PREFIX}-mmeta[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-mcheck { flex: none; color: var(--dsw-alias-label-primary); }

/* Stage: device views above this DSH's own frame. The stage has no box and resets the app-region the
   macOS shell gives every body child: a full-window no-drag box after #root would take the window
   drag away from every chrome row of this DSH, shown or not. */
.${PREFIX}-stage { display: contents; }
html[data-platform] body > .${PREFIX}-stage:not(#root) { -webkit-app-region: initial; }
.${PREFIX}-frame { position: fixed; inset: 0; z-index: 900; width: 100%; height: 100%; border: 0; background: transparent; visibility: hidden; color-scheme: normal; }
/* The shown device's window drag surface, repeated in this document: the native window reads
   app-regions from the top document only. The shell's row mark declares the drag and makes its
   watcher recollect the regions when these boxes change. */
.${PREFIX}-drag { position: fixed; z-index: 901; pointer-events: none; }
.${PREFIX}-drag-fallback { position: fixed; z-index: 901; left: 0; top: 0; right: 0; height: 12px; pointer-events: none; }
.${PREFIX}-pulse { position: fixed; left: 0; top: 0; width: 0; height: 0; pointer-events: none; }
.${PREFIX}-frame[data-current] { visibility: visible; animation: ${PREFIX}-in 180ms var(--ds-ease-in-out, ease) both; }
html.${PREFIX}-returning #root { animation: ${PREFIX}-in 180ms var(--ds-ease-in-out, ease) both; }
@keyframes ${PREFIX}-in { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .${PREFIX}-frame[data-current], html.${PREFIX}-returning #root { animation: none; } }
.${PREFIX}-anchor { position: fixed; pointer-events: none; }
html.${PREFIX}-remote #root { visibility: hidden !important; }
.${PREFIX}-chip { position: fixed; z-index: 902; left: 12px; bottom: 12px; display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px 0 10px; border: 0; border-radius: 999px; background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary); --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); box-shadow: var(--dsw-elevation-prominent, 0 4px 16px rgba(0,0,0,.12)); font: inherit; font-size: 13px; cursor: pointer; }

/* Add-device dialog */
.${PREFIX}-dialog { width: min(460px, 100%) !important; }
.${PREFIX}-form { display: flex; flex-direction: column; gap: 14px; width: 100%; }
.${PREFIX}-form .${PREFIX}-input { max-width: none; height: 36px; }
.${PREFIX}-hint { display: flex; align-items: center; gap: 6px; min-height: 18px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.${PREFIX}-hint[data-tone="ok"] { color: var(--dsw-alias-label-primary); }
.${PREFIX}-hint[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-actions { display: flex; justify-content: flex-end; gap: 8px; }
`;

    // -----------------------------------------------------------------------
    // Shared helpers
    // -----------------------------------------------------------------------

    function createStore(initial) {
      let snapshot = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        set(next) {
          snapshot = next;
          for (const listener of [...listeners]) listener();
        },
      };
    }

    class CallError extends Error {
      constructor(code, message) {
        super(message);
        this.code = code;
      }
    }

    function rpc(ctx) {
      return async (endpoint, payload = {}) => {
        const result = await ctx.connection.rpc.call(CHANNEL, `${ENDPOINT}/${endpoint}`, payload);
        if (!result.ok) throw new CallError(String(result.error?.code ?? '').replace(/^remote-relay\//, ''), result.error?.message ?? 'Request failed');
        return result.value;
      };
    }

    function fill(template, values) {
      return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
    }

    function formatDate(ms) {
      try {
        return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
      } catch {
        return new Date(ms).toLocaleString();
      }
    }

    function formatTime(ms) {
      try {
        return new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(ms);
      } catch {
        return new Date(ms).toLocaleTimeString();
      }
    }

    function formatAgo(ms, now) {
      const seconds = Math.round((ms - now) / 1000);
      const units = [['day', 86400], ['hour', 3600], ['minute', 60]];
      try {
        const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
        for (const [unit, size] of units) if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
        return format.format(0, 'second');
      } catch {
        return formatDate(ms);
      }
    }

    /** Read a pairing link or code far enough to preview it; the Host validates it again. */
    function previewPairing(text) {
      let value = String(text ?? '').trim();
      if (value === '') return null;
      const hash = value.indexOf('#');
      if (hash >= 0) value = value.slice(hash + 1);
      const params = new URLSearchParams(value);
      const serverId = params.get('s') ?? '';
      const expires = Number.parseInt(params.get('e') ?? '', 36) * 1000;
      if (!/^[A-Za-z0-9_-]{43}$/.test(serverId) || !params.get('i') || !params.get('k') || !params.get('r') || !Number.isFinite(expires)) {
        return { valid: false };
      }
      return { valid: true, serverId, host: (params.get('n') ?? '').slice(0, 80) || serverId.slice(0, 8), expiresAt: expires, expired: expires < Date.now() };
    }

    /** Short, localized reason a paired device cannot be reached, from the Host's failure code. */
    function describeRemote(remote, t) {
      const code = remote?.code ?? '';
      if (code === 'unknown-device') return fill(t('removedBy'), { name: remote.name });
      if (code === 'host-key') return t('err_host_key');
      if (code === 'relay-closed' || code === 'relay-timeout') return t('err_relay');
      return t('err_offline');
    }

    /** Most rectangles a device view may report for its window drag surface. */
    const MAX_DRAG_RECTS = 120;

    /**
     * The window drag surface this document declares, as disjoint `[left, top, right, bottom]`
     * viewport rectangles. Composition follows the native window: app-region boxes apply in document
     * order, a drag box adds its area and a no-drag box removes it, so the last box containing a
     * point decides. Only boxes that reach a marked chrome row can change the result.
     */
    function measureDragSurface() {
      const viewport = [0, 0, window.innerWidth, window.innerHeight];
      const clip = (rect) => [Math.max(rect.left, viewport[0]), Math.max(rect.top, viewport[1]), Math.min(rect.right, viewport[2]), Math.min(rect.bottom, viewport[3])];
      const empty = (box) => box[2] - box[0] < 1 || box[3] - box[1] < 1;
      const rows = [];
      for (const row of document.querySelectorAll('[data-window-drag]')) {
        const box = clip(row.getBoundingClientRect());
        if (!empty(box)) rows.push(box);
      }
      if (rows.length === 0) return [];
      const band = [Math.min(...rows.map((box) => box[0])), Math.min(...rows.map((box) => box[1])), Math.max(...rows.map((box) => box[2])), Math.max(...rows.map((box) => box[3]))];
      const without = (areas, hole) => {
        const out = [];
        for (const area of areas) {
          const left = Math.max(area[0], hole[0]);
          const top = Math.max(area[1], hole[1]);
          const right = Math.min(area[2], hole[2]);
          const bottom = Math.min(area[3], hole[3]);
          if (left >= right || top >= bottom) { out.push(area); continue; }
          if (area[1] < top) out.push([area[0], area[1], area[2], top]);
          if (bottom < area[3]) out.push([area[0], bottom, area[2], area[3]]);
          if (area[0] < left) out.push([area[0], top, left, bottom]);
          if (right < area[2]) out.push([right, top, area[2], bottom]);
        }
        return out;
      };
      let areas = [];
      for (const element of document.querySelectorAll('*')) {
        const rect = element.getBoundingClientRect();
        if (rect.bottom <= band[1] || rect.top >= band[3] || rect.right <= band[0] || rect.left >= band[2] || rect.width === 0 || rect.height === 0) continue;
        const style = getComputedStyle(element);
        const region = style.getPropertyValue('-webkit-app-region');
        if ((region !== 'drag' && region !== 'no-drag') || style.visibility !== 'visible') continue;
        const box = clip(rect);
        if (empty(box)) continue;
        if (region === 'no-drag') areas = without(areas, box);
        else if (!areas.some((area) => area[0] <= box[0] && area[1] <= box[1] && area[2] >= box[2] && area[3] >= box[3])) {
          areas = without(areas, box);
          areas.push(box);
        }
      }
      return areas.map((area) => area.map((value) => Math.round(value))).filter((area) => !empty(area)).slice(0, MAX_DRAG_RECTS);
    }

    function describeFailure(error, t) {
      const code = error instanceof CallError ? error.code : '';
      const message = error instanceof Error ? error.message : String(error);
      if (code === 'pairing-invalid') return t('err_pairing_invalid');
      if (code === 'self') return t('err_self');
      if (code === 'timeout' || code === 'relay-timeout') return t('err_timeout');
      if (code === 'relay-closed' || code === 'closed') return fill(t('err_unreachable'), { error: message });
      return message;
    }

    /**
     * Identity colors for devices. They are literal values on purpose: a device keeps its color in
     * every theme and on every DSH, because the color derives only from the device's key id.
     */
    const DEVICE_COLORS = ['#4C8DF6', '#8B6CF2', '#C561D9', '#E0628F', '#E8833A', '#2BA59F', '#2A9CC4', '#6AA84F'];
    function deviceColor(id) {
      if (typeof id !== 'string' || id === '') return undefined;
      let hash = 0x811c9dc5;
      for (let i = 0; i < id.length; i += 1) hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193) >>> 0;
      return DEVICE_COLORS[hash % DEVICE_COLORS.length];
    }

    /** A laptop whose screen carries the device's identity color, plus an optional status pip. */
    function DeviceGlyph({ size, tone, color }) {
      const s = size ?? 16;
      return h('span', { className: `${PREFIX}-sw-icon`, 'aria-hidden': true },
        h('svg', { width: s, height: s, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' },
          color ? h('rect', { x: 4.1, y: 4.6, width: 7.8, height: 4.7, rx: 0.6, fill: color, stroke: 'none' }) : null,
          h('rect', { x: 2.65, y: 3.15, width: 10.7, height: 7.6, rx: 1.35 }),
          h('path', { d: 'M1.5 13.1h13' })),
        tone === 'warn' || tone === 'error' ? h('span', { className: `${PREFIX}-pip`, 'data-tone': tone }) : null);
    }

    function Spinner({ size }) {
      return h('span', { className: `${PREFIX}-sw-icon ${PREFIX}-spin`, 'aria-hidden': true }, h(UI.IconLoadingOutlineRegular, { size: size ?? 16 }));
    }

    function deviceTone(state) {
      if (state === 'connected') return 'ok';
      if (state === 'connecting') return 'warn';
      if (state === 'retrying' || state === 'rejected') return 'error';
      return undefined;
    }

    // -----------------------------------------------------------------------
    // Settings controller (this DSH as a host)
    // -----------------------------------------------------------------------

    function createController(ctx) {
      const form = ctx.configForms.get(NAMESPACE);
      const call = rpc(ctx);
      let status = null;
      // Local clock minus Host clock, measured when the status arrives rather than at each render.
      let offset = 0;
      let loadFailed = false;
      let actionError = null;
      let busy = null;
      const writes = {};
      let watchers = 0;
      let timer;
      let disposed = false;
      let generation = 0;

      const projection = () => {
        const snapshot = form.getSnapshot();
        return {
          config: snapshot.value ?? null,
          configReady: snapshot.status === 'ready',
          writable: snapshot.writable === true,
          status,
          offset,
          loadFailed,
          actionError,
          busy,
          writes: { ...writes },
        };
      };
      const store = createStore(projection());
      const publish = () => { if (!disposed) store.set(projection()); };
      const offForm = form.subscribe(publish);

      const refresh = async () => {
        const current = ++generation;
        try {
          const value = await call('status');
          if (disposed || current !== generation) return;
          status = value;
          offset = Date.now() - value.now;
          loadFailed = false;
        } catch {
          if (disposed || current !== generation) return;
          loadFailed = true;
        }
        publish();
      };

      const schedule = () => {
        clearTimeout(timer);
        if (watchers > 0 && !disposed) timer = setTimeout(async () => { await refresh(); schedule(); }, POLL_MS);
      };

      const act = async (name, endpoint, payload) => {
        if (busy !== null) return;
        busy = name;
        actionError = null;
        publish();
        try {
          status = await call(endpoint, payload);
          offset = Date.now() - status.now;
          generation++;
        } catch (error) {
          actionError = error instanceof Error ? error.message : String(error);
        }
        busy = null;
        publish();
      };

      const write = async (field, value) => {
        clearTimeout(writes[field]?.timer);
        writes[field] = { saving: true };
        publish();
        let landed = false;
        try {
          landed = await form.set(field, value);
        } catch {
          landed = false;
        }
        writes[field] = landed
          ? { saved: true, timer: setTimeout(() => { writes[field] = {}; publish(); }, NOTICE_MS) }
          : { failed: true };
        publish();
        setTimeout(() => { void refresh(); }, 300);
        return landed;
      };

      return {
        dispose() {
          disposed = true;
          clearTimeout(timer);
          offForm();
          for (const entry of Object.values(writes)) clearTimeout(entry?.timer);
        },
        refresh: () => { if (watchers > 0) void refresh(); },
        face: {
          hooks: { remoteRelay: store },
          watch() {
            watchers++;
            if (watchers === 1) {
              void refresh();
              schedule();
            }
            return () => {
              watchers--;
              if (watchers === 0) clearTimeout(timer);
            };
          },
          retry: () => { void refresh(); },
          setField: (field, value) => write(field, value),
          pair: () => act('pair', 'pair'),
          cancelPairing: () => act('cancel', 'cancel-pairing'),
          revoke: (id) => act(`revoke:${id}`, 'revoke', { id }),
          copy: async (text) => {
            try {
              await navigator.clipboard.writeText(text);
              return true;
            } catch {
              return false;
            }
          },
        },
      };
    }

    // -----------------------------------------------------------------------
    // Device switcher controller
    // -----------------------------------------------------------------------

    /**
     * Top mode runs in a DSH window opened directly: it lists this DSH and the devices it added,
     * and shows a device by loading its loopback origin in a full-window frame. Frame mode runs in
     * such a frame: it only renders the trigger and asks the embedding window to open its menu.
     */
    function createSwitcher(ctx, t) {
      const call = rpc(ctx);
      const mode = window.parent === window ? 'top' : 'frame';
      let state = {
        mode,
        loaded: false,
        loadFailed: false,
        local: null,
        remotes: [],
        current: null,
        pending: null,
        pendingSince: 0,
        views: {},
        menu: null,
        add: null,
        removal: null,
        embed: null,
        embedGaveUp: false,
      };
      const store = createStore(state);
      const frames = new Map();
      const cleanups = [];
      let disposed = false;
      let pollTimer;
      let refreshing;
      let generation = 0;

      const set = (patch) => {
        if (disposed) return;
        state = { ...state, ...patch };
        store.set(state);
        afterChange();
      };
      const setView = (id, patch) => {
        const view = state.views[id];
        if (view === undefined) return;
        set({ views: { ...state.views, [id]: { ...view, ...patch } } });
      };
      const remoteOf = (id) => state.remotes.find((remote) => remote.id === id);
      const nameOf = (id) => remoteOf(id)?.name ?? '';

      // ---- Host state -------------------------------------------------------

      const refresh = () => {
        refreshing ??= (async () => {
          const current = ++generation;
          try {
            const value = await call('remotes');
            if (current !== generation) return;
            set({ loaded: true, loadFailed: false, local: value.local, remotes: value.remotes });
          } catch {
            if (current === generation) set({ loaded: true, loadFailed: true });
          } finally {
            refreshing = undefined;
          }
        })();
        return refreshing;
      };

      const needsPolling = () => state.menu !== null || state.pending !== null || state.add?.busy === true
        || Object.values(state.views).some((view) => view.failure && !view.ack)
        || Object.values(state.views).some((view) => view.phase !== 'ready');
      const schedulePoll = () => {
        if (pollTimer !== undefined || disposed) return;
        const interval = needsPolling() ? 1200 : state.current !== null ? 5000 : 0;
        if (interval === 0) return;
        pollTimer = setTimeout(async () => {
          pollTimer = undefined;
          await refresh();
          checkReadiness();
          schedulePoll();
        }, interval);
      };

      // ---- Switching --------------------------------------------------------

      const remember = (id) => {
        try {
          if (id === null) sessionStorage.removeItem(CURRENT_KEY);
          else sessionStorage.setItem(CURRENT_KEY, id);
        } catch { /* storage unavailable: the choice lasts until reload */ }
      };

      const show = (id) => {
        const returning = id === null && state.current !== null;
        if (id !== null && state.views[id]?.failure) setView(id, { failure: null, error: null });
        set({ current: id, pending: null, menu: null });
        remember(id);
        if (returning) {
          document.documentElement.classList.add(`${PREFIX}-returning`);
          setTimeout(() => { document.documentElement.classList.remove(`${PREFIX}-returning`); }, 260);
        }
        if (id === null) {
          requestAnimationFrame(() => { document.querySelector('#root textarea, #root [contenteditable="true"]')?.focus?.(); });
        } else {
          requestAnimationFrame(() => { frames.get(id)?.focus(); });
        }
      };

      const switchTo = async (id) => {
        if (state.mode !== 'top') return;
        if (id === null || id === state.current) {
          show(id);
          return;
        }
        if (state.views[id]?.phase === 'ready' && remoteOf(id)?.state === 'connected') {
          show(id);
          return;
        }
        set({ pending: id, pendingSince: Date.now(), menu: null });
        const view = state.views[id];
        if (view === undefined || view.origin === null || view.phase === 'failed') {
          try {
            const opened = await call('remote-open', { id });
            const previous = state.views[id];
            set({ views: { ...state.views, [id]: {
              origin: opened.origin,
              src: previous?.src ?? null,
              phase: previous?.src ? 'loading' : 'connecting',
              hello: false,
              loadedAt: 0,
              startedAt: Date.now(),
              error: null,
              reloads: (previous?.reloads ?? 0) + (previous?.src ? 1 : 0),
            } } });
          } catch (error) {
            set({ views: { ...state.views, [id]: { origin: null, src: null, phase: 'failed', failure: 'error', ack: false, hello: false, loadedAt: 0, startedAt: Date.now(), error: describeFailure(error, t), reloads: 0 } } });
            if (state.pending === id) set({ pending: null });
            return;
          }
        } else if (view.phase === 'ready') {
          // A view that loaded before keeps its page; the switch waits for its tunnel to return.
          void call('remote-open', { id }).catch(() => {});
        }
        await refresh();
        checkReadiness();
        schedulePoll();
      };

      const retry = (id) => {
        const view = state.views[id];
        if (view !== undefined) setView(id, { phase: 'failed' });
        void switchTo(id);
      };

      const cancelPending = () => { set({ pending: null }); };

      const runRow = (id, action) => {
        const remote = remoteOf(id);
        if (remote === undefined) return;
        if (action === 'readd') openAdd({ name: remote.name });
        else if (action === 'cancel') cancelPending();
        else if (action === 'retry') retry(id);
        else void switchTo(id);
      };

      const fail = (id, failure, error) => { setView(id, { phase: 'failed', failure, ack: false, error }); };

      const checkReadiness = () => {
        for (const [id, view] of Object.entries(state.views)) {
          const remote = remoteOf(id);
          if (remote === undefined) continue;
          if (view.phase !== 'failed' && remote.state === 'rejected') {
            fail(id, 'removed', fill(t('removedBy'), { name: remote.name }));
            // The device refused this DSH: its page cannot work any more, so leave it.
            if (state.current === id) show(null);
          } else if (view.phase === 'connecting' && remote.state === 'connected') {
            // Load the view only through an open tunnel, so its first page cannot be a relay timeout.
            const src = view.reloads > 0 ? `${view.origin}/?r=${Date.now().toString(36)}` : `${view.origin}/`;
            setView(id, { phase: 'loading', src, loadedAt: 0, hello: false });
          } else if (view.phase === 'connecting' && Date.now() - view.startedAt > 25_000) {
            fail(id, 'unreachable', describeRemote(remote, t));
          } else if (view.phase === 'loading' && view.loadedAt > 0 && !view.hello && Date.now() - view.loadedAt > 6000) {
            // A device without this plugin version never says hello; show it once its page has loaded.
            setView(id, { phase: 'ready' });
          }
        }
        const pending = state.pending;
        const pendingView = pending === null ? undefined : state.views[pending];
        if (pendingView === undefined) return;
        if (pendingView.phase === 'ready' && remoteOf(pending)?.state === 'connected') show(pending);
        else if (pendingView.phase === 'failed') set({ pending: null });
        else if (pendingView.phase === 'ready' && Date.now() - state.pendingSince > 25_000) {
          // The page stays loaded for a later attempt; this attempt reports the tunnel failure.
          set({ pending: null });
          setView(pending, { failure: 'unreachable', ack: false, error: describeRemote(remoteOf(pending), t), phase: 'ready' });
        }
      };

      const frameLoaded = (id) => {
        setView(id, { loadedAt: Date.now() });
        sendContext(id);
        schedulePoll();
      };

      // ---- Menu and dialogs -------------------------------------------------

      const openMenu = (rect, options = {}) => {
        if (state.mode === 'frame') {
          set({ menu: { rect, keyboard: options.keyboard === true, returnFocus: options.returnFocus ?? null } });
          post(window.parent, { type: 'menu-open' });
          return;
        }
        set({ menu: { rect, keyboard: options.keyboard === true, returnFocus: options.returnFocus ?? null } });
        acknowledge();
        void refresh();
        schedulePoll();
      };
      const acknowledge = () => {
        const views = { ...state.views };
        let changed = false;
        for (const [id, view] of Object.entries(views)) {
          if (view.failure && !view.ack) { views[id] = { ...view, ack: true }; changed = true; }
        }
        if (changed) set({ views });
      };
      const closeMenu = () => { if (state.menu !== null) set({ menu: null }); };

      const openAdd = (preset) => {
        if (state.mode === 'frame') {
          post(window.parent, { type: 'add' });
          return;
        }
        set({ menu: null, add: { busy: false, error: null, readd: preset ?? null } });
      };
      const closeAdd = () => { if (state.add?.busy !== true) set({ add: null }); };

      const add = async (code, name) => {
        if (state.add === null || state.add.busy) return;
        set({ add: { ...state.add, busy: true, error: null } });
        try {
          const value = await call('remote-add', { code, name });
          set({ local: value.local, remotes: value.remotes, add: null });
          const stale = state.views[value.added];
          if (stale !== undefined) {
            const views = { ...state.views };
            delete views[value.added];
            set({ views });
          }
          void switchTo(value.added);
        } catch (error) {
          set({ add: { ...state.add, busy: false, error: describeFailure(error, t) } });
        }
      };

      const remove = async () => {
        const removal = state.removal;
        if (removal === null || removal.busy) return;
        // The Host first asks that device to remove this DSH, which can take a few seconds.
        set({ removal: { ...removal, busy: true, error: null } });
        try {
          const value = await call('remote-remove', { id: removal.id });
          generation += 1;
          const views = { ...state.views };
          delete views[removal.id];
          frames.delete(removal.id);
          set({
            local: value.local,
            remotes: value.remotes,
            views,
            current: state.current === removal.id ? null : state.current,
            pending: state.pending === removal.id ? null : state.pending,
            // The dialog stays open only to say the other device may still list this DSH.
            removal: value.forgotten === false ? { ...removal, busy: false, unconfirmed: true } : null,
          });
          if (state.current === null) remember(null);
        } catch (error) {
          set({ removal: { ...removal, busy: false, error: describeFailure(error, t) } });
        }
      };
      const openRemove = (id) => {
        if (state.mode === 'frame') {
          post(window.parent, { type: 'remove', id });
          return;
        }
        if (remoteOf(id) === undefined || state.removal?.busy === true) return;
        set({ menu: null, removal: { id, name: nameOf(id), busy: false, error: null, unconfirmed: false } });
      };
      const closeRemove = () => { if (state.removal?.busy !== true) set({ removal: null }); };

      // ---- Bridge between a device view and the window that shows it ---------

      // The embedding window's origin is unknown to a view (dsh-app:// or the Web GUI); the
      // messages carry no secrets, and the embedding window checks their source frame.
      const post = (target, message) => {
        try {
          target.postMessage({ channel: BRIDGE, v: BRIDGE_VERSION, ...message }, '*');
        } catch { /* the embedding window is gone */ }
      };

      const mirroredAttributes = () => Object.fromEntries(MIRRORED_ATTRIBUTES.map((name) => [name, document.documentElement.getAttribute(name)]));

      const pendingInfo = () => {
        if (state.pending === null) {
          const failed = Object.entries(state.views).find(([id, view]) => view.failure && !view.ack && id !== state.current);
          return failed === undefined ? null : { name: nameOf(failed[0]), state: failed[1].failure === 'removed' ? 'removed' : 'failed', error: failed[1].error };
        }
        return { name: nameOf(state.pending), state: 'connecting', error: null };
      };

      const contextOf = (id) => ({
        channel: BRIDGE,
        v: BRIDGE_VERSION,
        type: 'context',
        id,
        name: nameOf(id),
        state: remoteOf(id)?.state ?? 'idle',
        shown: state.current === id,
        pending: pendingInfo(),
        rows: deviceRows(state, t),
        attributes: mirroredAttributes(),
      });
      const sentContext = new Map();
      const sendContext = (id, force = false) => {
        const frame = frames.get(id);
        const view = state.views[id];
        if (frame?.contentWindow == null || view === undefined) return;
        const message = contextOf(id);
        const key = JSON.stringify(message);
        if (!force && sentContext.get(id) === key) return;
        sentContext.set(id, key);
        frame.contentWindow.postMessage(message, view.origin);
      };

      // ---- Window drag surface of a device view ------------------------------

      // The macOS window takes its drag regions from the top document only, so the view on screen
      // reports where its own chrome rows would drag and the embedding window repeats those boxes.
      let dragTimer;
      let dragSent = null;
      let dragMeasuredAt = 0;
      let dragCost = 0;
      const dragWanted = () => state.mode === 'frame' && state.embed?.shown === true && document.documentElement.getAttribute('data-platform') === 'darwin';
      const reportDrag = () => {
        dragTimer = undefined;
        if (disposed || !dragWanted()) return;
        const started = performance.now();
        const rects = measureDragSurface();
        dragCost = performance.now() - started;
        dragMeasuredAt = Date.now();
        const key = JSON.stringify(rects);
        if (key === dragSent) return;
        dragSent = key;
        post(window.parent, { type: 'drag', rects });
      };
      const scheduleDrag = () => {
        if (dragTimer !== undefined || disposed || !dragWanted()) return;
        // Measuring reads every element's box; keep it to a small share of the main thread.
        const gap = Math.min(3000, Math.max(400, dragCost * 30));
        dragTimer = setTimeout(reportDrag, Math.max(30, dragMeasuredAt + gap - Date.now()));
      };

      const afterChange = () => {
        document.documentElement.classList.toggle(`${PREFIX}-remote`, state.mode === 'top' && state.current !== null);
        // Every view hears changes, so the one that leaves the screen stops measuring its drag surface.
        if (state.mode === 'top') for (const id of Object.keys(state.views)) sendContext(id);
        else scheduleDrag();
      };

      const onTopMessage = (event) => {
        const data = event.data;
        if (data?.channel !== BRIDGE || data.v !== BRIDGE_VERSION) return;
        const id = [...frames.entries()].find(([, frame]) => frame.contentWindow === event.source)?.[0];
        if (id === undefined || event.origin !== state.views[id]?.origin) return;
        if (data.type === 'hello') {
          // `drag` stays unset until the view reports, so the fallback strip covers the first frames.
          if (!state.views[id].hello) setView(id, { hello: true, phase: 'ready' });
          sendContext(id, true);
          checkReadiness();
          return;
        }
        if (data.type === 'drag') {
          const bounds = [0, 0, window.innerWidth, window.innerHeight];
          const drag = (Array.isArray(data.rects) ? data.rects : []).slice(0, MAX_DRAG_RECTS)
            .map((rect) => (Array.isArray(rect) ? rect.slice(0, 4).map(Number) : []))
            .filter((rect) => rect.length === 4 && rect.every(Number.isFinite))
            .map((rect) => [Math.max(rect[0], bounds[0]), Math.max(rect[1], bounds[1]), Math.min(rect[2], bounds[2]), Math.min(rect[3], bounds[3])])
            .filter((rect) => rect[2] > rect[0] && rect[3] > rect[1]);
          if (JSON.stringify(drag) !== JSON.stringify(state.views[id].drag ?? [])) setView(id, { drag });
          return;
        }
        if (id !== state.current) return;
        if (data.type === 'menu-open') {
          acknowledge();
          // The view renders the menu; fresh rows arrive with the next context message.
          void refresh().then(() => { sendContext(id); });
        } else if (data.type === 'add') {
          openAdd();
        } else if (data.type === 'remove' && typeof data.id === 'string') {
          openRemove(data.id);
        } else if (data.type === 'local') {
          show(null);
        } else if (data.type === 'row' && typeof data.id === 'string') {
          runRow(data.id, ['switch', 'cancel', 'retry', 'readd'].includes(data.action) ? data.action : 'switch');
        }
      };

      const onFrameMessage = (event) => {
        const data = event.data;
        if (event.source !== window.parent || data?.channel !== BRIDGE || data.v !== BRIDGE_VERSION || data.type !== 'context') return;
        for (const name of MIRRORED_ATTRIBUTES) {
          const value = data.attributes?.[name];
          if (typeof value === 'string') document.documentElement.setAttribute(name, value);
          else document.documentElement.removeAttribute(name);
        }
        const pending = data.pending && typeof data.pending.name === 'string'
          ? { name: data.pending.name, state: ['failed', 'removed'].includes(data.pending.state) ? data.pending.state : 'connecting' }
          : null;
        const text = (value) => String(value ?? '').slice(0, 200);
        const rows = {
          // The phone launcher sends no local row: a browser is not a DSH to switch back to.
          local: data.rows?.local ? { id: text(data.rows.local.id), name: text(data.rows.local.name), current: false } : null,
          // Only a DSH window with this plugin version answers a removal request; the launcher does not.
          removable: data.rows?.removable === true,
          remotes: (Array.isArray(data.rows?.remotes) ? data.rows.remotes : []).slice(0, 50).map((row) => ({
            id: text(row?.id),
            name: text(row?.name),
            meta: text(row?.meta),
            metaTone: row?.metaTone === 'error' ? 'error' : undefined,
            tone: ['ok', 'warn', 'error'].includes(row?.tone) ? row.tone : undefined,
            current: row?.current === true,
            busy: row?.busy === true,
            action: text(row?.action),
          })),
        };
        const shown = data.shown === true;
        // A view that returns to the screen reports again: the window may have dropped its last report.
        if (shown && state.embed?.shown !== true) dragSent = null;
        set({ embed: { id: text(data.id), name: text(data.name), state: text(data.state), shown, pending, rows } });
      };

      if (mode === 'top') {
        window.addEventListener('message', onTopMessage);
        cleanups.push(() => { window.removeEventListener('message', onTopMessage); });
        const observer = new MutationObserver(() => {
          for (const id of Object.keys(state.views)) sendContext(id);
        });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: MIRRORED_ATTRIBUTES });
        cleanups.push(() => { observer.disconnect(); });
        void refresh().then(() => {
          let saved = null;
          try { saved = sessionStorage.getItem(CURRENT_KEY); } catch { saved = null; }
          if (saved !== null && remoteOf(saved) !== undefined) void switchTo(saved);
        });
      } else {
        window.addEventListener('message', onFrameMessage);
        cleanups.push(() => { window.removeEventListener('message', onFrameMessage); });
        const started = Date.now();
        const hello = setInterval(() => {
          if (state.embed !== null || Date.now() - started > 12_000) {
            clearInterval(hello);
            if (state.embed === null) set({ embedGaveUp: true });
            return;
          }
          post(window.parent, { type: 'hello', restore: true });
        }, 400);
        post(window.parent, { type: 'hello', restore: true });
        cleanups.push(() => { clearInterval(hello); });
        const moved = new MutationObserver(scheduleDrag);
        moved.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
        const heartbeat = setInterval(scheduleDrag, 2500);
        const motion = ['resize', 'scroll', 'transitionend', 'animationend'];
        for (const type of motion) window.addEventListener(type, scheduleDrag, true);
        cleanups.push(() => {
          moved.disconnect();
          clearInterval(heartbeat);
          clearTimeout(dragTimer);
          for (const type of motion) window.removeEventListener(type, scheduleDrag, true);
        });
      }

      return {
        refresh: () => { void refresh(); },
        dispose() {
          disposed = true;
          clearTimeout(pollTimer);
          for (const cleanup of cleanups) cleanup();
          document.documentElement.classList.remove(`${PREFIX}-remote`);
        },
        face: {
          hooks: { switcher: store },
          openMenu,
          closeMenu,
          cancelPending,
          retry,
          runRow: (id, action) => {
            if (state.mode === 'frame') post(window.parent, { type: 'row', id, action });
            else runRow(id, action);
          },
          switchTo: (id) => {
            if (state.mode === 'frame') post(window.parent, id === null ? { type: 'local' } : { type: 'row', id, action: 'switch' });
            else void switchTo(id);
          },
          openAdd,
          closeAdd,
          add: (code, name) => { void add(code, name); },
          openRemove,
          closeRemove,
          remove: () => { void remove(); },
          registerFrame: (id, element) => {
            if (element === null) frames.delete(id);
            else frames.set(id, element);
          },
          frameLoaded,
        },
      };
    }

    // -----------------------------------------------------------------------
    // Last opened Session
    // -----------------------------------------------------------------------

    /**
     * Every window of this DSH reports the Session it shows to the Host, and a window that starts
     * reopens the Session last opened in any window (the computer, a phone, another DSH). DSH first
     * restores the selection it saved in this browser; when the Host's Session differs, it is opened
     * instead, and a Session that was deleted or archived starts a new one. Reporting begins once
     * that settles, so a stale selection never overwrites the Host's.
     * @param {object} ctx - Client context.
     * @param {() => void} onSettled - called once the starting Session is shown.
     */
    function createSessionMemory(ctx, onSettled) {
      const call = rpc(ctx);
      let disposed = false;
      let reported;
      let timer;
      const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
      const savedId = () => {
        try {
          const saved = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? 'null');
          return typeof saved?.sessionId === 'string' ? saved.sessionId : undefined;
        } catch {
          return undefined;
        }
      };
      // The saved selection counts once DSH's main view holds that Session.
      const shown = () => {
        const id = savedId();
        const sessions = ctx.get('sessions');
        if (id === undefined || sessions === undefined) return undefined;
        try {
          return (sessions.retainInfo(id).getSnapshot().retainedBy?.mainView ?? 0) > 0 ? id : undefined;
        } catch {
          return undefined;
        }
      };
      const listsReady = () => ctx.get('sessions')?.list?.getSnapshot().phase === 'ready'
        && ctx.get('workspaces')?.list?.getSnapshot().phase === 'ready';
      const usable = (id) => ctx.get('sessions').list.getSnapshot().byId[id] !== undefined
        && !ctx.get('workspaces').list.getSnapshot().archivedSessionIds.includes(id);

      const restore = async () => {
        let last = null;
        try {
          last = (await call('last-session'))?.id ?? null;
        } catch { /* a Host without this operation records nothing */ }
        const listsBy = Date.now() + 20_000;
        while (!disposed && !listsReady() && Date.now() < listsBy) await sleep(100);
        if (disposed || !listsReady()) return;
        // DSH restores this browser's own selection as soon as the lists are ready.
        const restoredBy = Date.now() + 3000;
        while (!disposed && shown() === undefined && Date.now() < restoredBy) await sleep(100);
        const ui = ctx.get('uiWorkspace');
        if (disposed || last === null || ui === undefined) return;
        if (!usable(last)) ui.startSession();
        else if (shown() !== last) ui.openSession(last);
        else return;
        const openedBy = Date.now() + 5000;
        while (!disposed && shown() === undefined && Date.now() < openedBy) await sleep(100);
        if (!disposed && usable(last)) {
          while (!disposed && shown() !== last && Date.now() < openedBy) await sleep(100);
        }
      };
      const track = () => {
        const id = shown();
        if (id === undefined || id === reported) return;
        reported = id;
        void call('session-opened', { id }).catch(() => { reported = undefined; });
      };
      void restore().catch(() => {}).finally(() => {
        if (disposed) return;
        onSettled();
        track();
        timer = setInterval(track, 1000);
      });
      return {
        dispose() {
          disposed = true;
          clearInterval(timer);
        },
      };
    }

    // -----------------------------------------------------------------------
    // Settings components
    // -----------------------------------------------------------------------

    function Row({ title, desc, children }) {
      return h('div', { className: `${PREFIX}-row` },
        h('div', { className: `${PREFIX}-label` },
          h('div', { className: `${PREFIX}-title` }, title),
          desc ? h('div', { className: `${PREFIX}-desc` }, desc) : null),
        h('div', { className: `${PREFIX}-control` }, children));
    }

    function WriteStatus({ write, t }) {
      if (write?.saving) return null;
      if (write?.failed) return h('span', { className: `${PREFIX}-status`, 'data-tone': 'error', role: 'alert' }, t('saveFailed'));
      if (write?.saved) return h('span', { className: `${PREFIX}-status`, role: 'status' }, t('saved'));
      return null;
    }

    function TextSetting({ field, title, desc, placeholder, value, write, disabled, onSave, t }) {
      const [draft, setDraft] = useState(value);
      const [focused, setFocused] = useState(false);
      useEffect(() => { if (!focused) setDraft(value); }, [value, focused]);
      const dirty = draft.trim() !== value;
      const save = () => { if (dirty) void onSave(field, draft.trim()); };
      return h(Row, { title, desc },
        h('input', {
          className: `${PREFIX}-input`,
          type: 'text',
          value: draft,
          placeholder,
          disabled,
          spellCheck: false,
          autoComplete: 'off',
          'aria-label': title,
          onFocus: () => { setFocused(true); },
          onBlur: () => { setFocused(false); },
          onChange: (event) => { setDraft(event.target.value); },
          onKeyDown: (event) => {
            if (event.key === 'Enter') save();
            else if (event.key === 'Escape') setDraft(value);
          },
        }),
        dirty
          ? h('button', { type: 'button', className: `${PREFIX}-button`, 'data-primary': true, disabled: disabled || write?.saving, onMouseDown: (event) => { event.preventDefault(); }, onClick: save }, t('save'))
          : h(WriteStatus, { write, t }));
    }

    function CopyField({ label, value, mono, copy, t }) {
      const [copied, setCopied] = useState(false);
      useEffect(() => {
        if (!copied) return undefined;
        const timer = setTimeout(() => { setCopied(false); }, NOTICE_MS);
        return () => { clearTimeout(timer); };
      }, [copied]);
      return h('div', { className: `${PREFIX}-field` },
        label ? h('span', { className: `${PREFIX}-field-label` }, label) : null,
        h('div', { className: `${PREFIX}-copy-row` },
          h('input', { className: `${PREFIX}-input${mono ? ` ${PREFIX}-mono` : ''}`, type: 'text', readOnly: true, value, 'aria-label': label, onFocus: (event) => { event.target.select(); } }),
          h('button', { type: 'button', className: `${PREFIX}-button`, onClick: async () => { if (await copy(value)) setCopied(true); } }, copied ? t('copied') : t('copy'))));
    }

    function Countdown({ expiresAt, offset, t }) {
      // The local deadline is fixed per pairing: each status poll measures a slightly different offset.
      const deadline = useMemo(() => expiresAt + offset, [expiresAt]);
      const [tick, setTick] = useState(0);
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      useEffect(() => {
        if (left === 0) return undefined;
        // Wake just after the next whole second so each second is shown once.
        const timer = setTimeout(() => { setTick((n) => n + 1); }, ((deadline - Date.now()) % 1000) + 20);
        return () => { clearTimeout(timer); };
      }, [deadline, tick]);
      const text = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      return h('span', { className: `${PREFIX}-status ${PREFIX}-countdown` }, fill(t('expiresIn'), { time: text }));
    }

    function stateTone(state) {
      if (state === 'online') return 'ok';
      if (state === 'connecting' || state === 'starting' || state === 'unconfigured') return 'warn';
      if (state === 'offline' || state === 'error' || state === 'replaced') return 'error';
      return 'idle';
    }

    function ConfirmButton({ label, confirmLabel, disabled, onConfirm }) {
      const [confirming, setConfirming] = useState(false);
      useEffect(() => {
        if (!confirming) return undefined;
        const timer = setTimeout(() => { setConfirming(false); }, 4000);
        return () => { clearTimeout(timer); };
      }, [confirming]);
      return h('button', {
        type: 'button',
        className: `${PREFIX}-button`,
        'data-size': 'small',
        'data-danger': true,
        disabled,
        onClick: () => { if (confirming) { setConfirming(false); onConfirm(); } else setConfirming(true); },
      }, confirming ? confirmLabel : label);
    }

    function DeviceRow({ device, now, busy, onRevoke, t }) {
      const details = [fill(t('pairedAt'), { date: formatDate(device.pairedAt) })];
      if (device.lastSeenAt) details.push(fill(t('lastSeen'), { time: formatAgo(device.lastSeenAt, now) }));
      return h('div', { className: `${PREFIX}-device` },
        h('div', { className: `${PREFIX}-device-main` },
          h('div', { className: `${PREFIX}-device-name` }, device.name, device.connections > 0 ? h('span', { className: `${PREFIX}-badge` }, t('online')) : null),
          h('div', { className: `${PREFIX}-desc` }, details.join(' · '))),
        h(ConfirmButton, { label: t('remove'), confirmLabel: t('confirmRemove'), disabled: busy !== null, onConfirm: () => { onRevoke(device.id); } }));
    }

    function RemoteAccessSection(props) {
      const { t } = props;
      const state = props.useRemoteRelay((snapshot) => snapshot);
      const watch = props.watch;
      useEffect(() => watch(), [watch]);
      const config = state.config ?? {};
      const status = state.status;
      const enabled = config.enabled === true;
      const control = status?.control?.state ?? 'starting';
      const offset = state.offset;
      const editable = state.configReady && state.writable;
      const onlineCount = (status?.devices ?? []).filter((device) => device.connections > 0).length;
      const stateDetail = control === 'online' ? fill(t('onlineDetail'), { count: onlineCount }) : status?.control?.error ?? status?.relayError ?? '';
      const pairing = status?.pairing;
      const launcherBase = (config.launcherUrl ?? '').trim();
      const pairLink = pairing ? (pairing.link ?? `dsh-remote://pair#${pairing.code}`) : '';
      let launcherValid = true;
      try { if (launcherBase) new URL(launcherBase); } catch { launcherValid = false; }

      return h('div', { className: `${PREFIX}-root` },
        h('style', null, CSS),
        h('p', { className: `${PREFIX}-lead` }, t('lead')),
        h('section', { className: `${PREFIX}-group`, 'aria-labelledby': `${PREFIX}-host` },
          h('h3', { id: `${PREFIX}-host`, className: `${PREFIX}-heading` }, t('hostHeading')),
          h('div', { className: `${PREFIX}-desc` }, t('hostIntro')),
          h(Row, { title: t('enable'), desc: t('enableTip') },
            h(WriteStatus, { write: state.writes.enabled, t }),
            h('button', {
              type: 'button',
              role: 'switch',
              className: `${PREFIX}-switch`,
              'aria-checked': enabled,
              'aria-label': t('enable'),
              disabled: !editable || state.writes.enabled?.saving,
              onClick: () => { void props.setField('enabled', !enabled); },
            }, h('span', { className: `${PREFIX}-thumb` }))),
          h(Row, { title: t('status'), desc: stateDetail },
            state.loadFailed && status === null
              ? h(React.Fragment, null,
                h('span', { className: `${PREFIX}-status`, 'data-tone': 'error', role: 'alert' }, t('loadFailed')),
                h('button', { type: 'button', className: `${PREFIX}-button`, 'data-size': 'small', onClick: props.retry }, t('retry')))
              : h('span', { className: `${PREFIX}-state`, role: 'status' },
                h('span', { className: `${PREFIX}-dot`, 'data-tone': stateTone(control) }),
                t(`state_${control}`))),
          h(TextSetting, { field: 'relayUrl', title: t('relay'), desc: t('relayTip'), placeholder: t('relayPlaceholder'), value: config.relayUrl ?? '', write: state.writes.relayUrl, disabled: !editable, onSave: props.setField, t }),
          h(TextSetting, { field: 'hostName', title: t('hostName'), desc: t('hostNameTip'), placeholder: status?.hostName ?? '', value: config.hostName ?? '', write: state.writes.hostName, disabled: !editable, onSave: props.setField, t }),
          h(TextSetting, { field: 'launcherUrl', title: t('launcher'), desc: t('launcherTip'), placeholder: t('launcherPlaceholder'), value: config.launcherUrl ?? '', write: state.writes.launcherUrl, disabled: !editable, onSave: props.setField, t })),
        h('section', { className: `${PREFIX}-group`, 'aria-labelledby': `${PREFIX}-pair` },
          h('h3', { id: `${PREFIX}-pair`, className: `${PREFIX}-heading` }, t('pairHeading')),
          h('div', { className: `${PREFIX}-desc` }, t('pairIntro')),
          pairing
            ? h('div', { className: `${PREFIX}-pairing` },
              h('div', { className: `${PREFIX}-fields` },
                h(CopyField, { label: t('pairLink'), value: pairLink, mono: true, copy: props.copy, t }),
                h('div', { className: `${PREFIX}-desc`, style: { marginTop: -4 } }, t('pairLinkTip')),
                h('div', { className: `${PREFIX}-copy-row` },
                  h(Countdown, { expiresAt: pairing.expiresAt, offset, t }),
                  h('span', { style: { flex: 1 } }),
                  h('button', { type: 'button', className: `${PREFIX}-button`, 'data-size': 'small', disabled: state.busy !== null, onClick: props.cancelPairing }, t('cancel')))),
              pairing.link
                ? h('div', { className: `${PREFIX}-qr-box` },
                  h(QrCode, { text: pairing.link, label: t('scan') }),
                  h('span', { className: `${PREFIX}-status` }, t('scan')))
                : null)
            : h('div', { className: `${PREFIX}-row` },
              h('div', { className: `${PREFIX}-label` },
                control === 'online' ? null : h('div', { className: `${PREFIX}-status` }, t('pairNeedsOnline'))),
              h('div', { className: `${PREFIX}-control` },
                h('button', { type: 'button', className: `${PREFIX}-button`, 'data-primary': true, disabled: control !== 'online' || state.busy !== null || !launcherValid, onClick: props.pair }, t('pairAction')))),
          state.actionError ? h('p', { className: `${PREFIX}-error`, role: 'alert' }, state.actionError) : null,
          h('p', { className: `${PREFIX}-note` }, t('risk'))),
        h('section', { className: `${PREFIX}-group`, 'aria-labelledby': `${PREFIX}-devices` },
          h('h3', { id: `${PREFIX}-devices`, className: `${PREFIX}-heading` }, t('devices')),
          (status?.devices ?? []).length === 0
            ? h('div', { className: `${PREFIX}-desc`, style: { padding: '8px 0' } }, t('noDevices'))
            : h('div', null, status.devices.map((device) => h(DeviceRow, { key: device.id, device, now: Date.now() - offset, busy: state.busy, onRevoke: props.revoke, t })))),
        status?.serverId
          ? h('div', { className: `${PREFIX}-footer` }, `${t('hostId')}: `, h('span', { className: `${PREFIX}-mono` }, status.serverId))
          : null);
    }

    function SectionIcon({ size }) {
      const s = size ?? 16;
      return h('svg', { width: s, height: s, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 1.75, y: 6.5, width: 4, height: 7, rx: 1 }),
        h('rect', { x: 8.75, y: 6.5, width: 5.5, height: 4, rx: 0.8 }),
        h('path', { d: 'M10.25 13.25h2.5M11.5 10.5v2.75' }),
        h('path', { d: 'M3.75 4.5C5 2.6 6.4 1.75 8 1.75s3 .85 4.25 2.75', strokeDasharray: '0.1 2' }));
    }

    // -----------------------------------------------------------------------
    // Device switcher components
    // -----------------------------------------------------------------------

    /** Sidebar-foot trigger: the device this window shows, and the entry to switch or add one. */
    function SwitcherButton(props) {
      const { t, wide } = props;
      const state = props.useSwitcher((snapshot) => snapshot);
      const ref = useRef(null);
      if (state.mode === 'frame' && state.embed === null) return null;
      let name;
      let tag = null;
      let tone;
      let color;
      let busy = false;
      let failed = false;
      if (state.mode === 'frame') {
        name = state.embed.name;
        tag = t('remoteTag');
        tone = deviceTone(state.embed.state);
        color = deviceColor(state.embed.id);
        const pendingName = state.embed.pending?.name;
        if (state.embed.pending?.state === 'connecting') { busy = true; name = fill(t('connectingTo'), { name: pendingName }); tag = null; }
        else if (state.embed.pending?.state === 'failed') { failed = true; name = fill(t('cannotReach'), { name: pendingName }); tag = null; }
        else if (state.embed.pending?.state === 'removed') { failed = true; name = fill(t('removedBy'), { name: pendingName }); tag = null; }
      } else {
        name = t('thisDevice');
        color = deviceColor(state.local?.serverId);
        const pending = state.pending === null ? undefined : state.remotes.find((remote) => remote.id === state.pending);
        const failedView = Object.entries(state.views).find(([, view]) => view.failure && !view.ack);
        if (pending !== undefined) { busy = true; name = fill(t('connectingTo'), { name: pending.name }); }
        else if (failedView !== undefined) {
          failed = true;
          const failedName = state.remotes.find((remote) => remote.id === failedView[0])?.name ?? '';
          name = fill(t(failedView[1].failure === 'removed' ? 'removedBy' : 'cannotReach'), { name: failedName });
        }
      }
      const open = state.menu !== null;
      const label = wide ? name : `${t('switcher')}: ${name}`;
      const onActivate = (keyboard) => {
        const rect = ref.current?.getBoundingClientRect();
        if (rect === undefined) return;
        if (open) props.closeMenu();
        else props.openMenu({ left: rect.left, top: rect.top, width: rect.width, height: rect.height }, { keyboard, returnFocus: () => ref.current });
      };
      const button = h('button', {
        ref,
        type: 'button',
        className: `${PREFIX}-sw`,
        'data-rail': wide ? undefined : true,
        'data-tone': failed ? 'error' : undefined,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-label': wide ? undefined : label,
        title: wide ? t('switcher') : undefined,
        onClick: (event) => { onActivate(event.detail === 0); },
      },
      busy ? h(Spinner, { size: wide ? 16 : 18 }) : h(DeviceGlyph, { size: wide ? 16 : 18, tone: failed ? 'error' : tone, color }),
      wide ? h('span', { className: `${PREFIX}-sw-label` }, name) : null,
      wide && tag ? h('span', { className: `${PREFIX}-sw-tag` }, tag) : null,
      wide ? h(UI.IconChevronsUpDownOutlineRegular, { size: 14, className: `${PREFIX}-sw-chevron` }) : null);
      return h(React.Fragment, null,
        h('style', null, CSS),
        wide ? button : h(UI.Tooltip, { label, side: 'right', disabled: open }, button),
        state.mode === 'frame'
          ? h(DeviceMenu, {
            open,
            anchorRef: ref,
            rows: state.embed.rows,
            keyboard: state.menu?.keyboard,
            returnFocus: () => ref.current,
            onClose: props.closeMenu,
            onLocal: () => { props.switchTo(null); },
            onRow: (row) => { props.runRow(row.id, row.action); },
            onAdd: () => { props.openAdd(); },
            onRemove: props.openRemove,
            t,
          })
          : null);
    }

    function MenuRowContent({ name, meta, metaTone, current, busy }) {
      return h('span', { className: `${PREFIX}-mrow` },
        h('span', { className: `${PREFIX}-mname` },
          h('span', null, name),
          meta ? h('span', { className: `${PREFIX}-mmeta`, 'data-tone': metaTone }, meta) : null),
        busy ? h(Spinner, { size: 14 }) : current ? h(UI.IconCheckOutlineRegular, { size: 14, className: `${PREFIX}-mcheck` }) : null);
    }

    /** Menu rows the window that owns the devices computes; device views render the same rows. */
    function deviceRows(state, t) {
      const remotes = state.remotes.map((remote) => {
        const view = state.views[remote.id];
        const busy = state.pending === remote.id;
        let meta = t(`device_${remote.state}`);
        let metaTone;
        let action = 'switch';
        if (remote.state === 'rejected') { meta = t('readdHint'); metaTone = 'error'; action = 'readd'; }
        else if (busy) { meta = t('device_connecting_cancel'); action = 'cancel'; }
        else if (view?.phase === 'failed' || (view?.failure && remote.state !== 'connected')) { meta = fill(t('retryHint'), { reason: view.error ?? describeRemote(remote, t) }); metaTone = 'error'; action = 'retry'; }
        else if (remote.state === 'retrying') { meta = describeRemote(remote, t); metaTone = 'error'; }
        else if (remote.state === 'idle' && remote.lastOpenedAt) meta = fill(t('lastSeen'), { time: formatAgo(remote.lastOpenedAt, Date.now()) });
        return {
          id: remote.id,
          name: remote.name,
          meta,
          metaTone,
          tone: metaTone === 'error' ? 'error' : deviceTone(remote.state),
          current: state.current === remote.id,
          busy,
          action,
        };
      });
      return { local: { id: state.local?.serverId ?? '', name: state.local?.name ?? '', current: state.current === null }, removable: true, remotes };
    }

    function DeviceMenu({ open, anchorRef, rows, keyboard, returnFocus, onClose, onLocal, onRow, onAdd, onRemove, t }) {
      const footer = [{ id: 'add', label: t('addDevice'), icon: h(UI.IconPlusOutlineRegular, { size: 16 }) }];
      if (rows.removable && rows.remotes.length > 0) {
        footer.push({
          id: 'remove',
          label: t('removeDevice'),
          icon: h(UI.IconTrashOutlineRegular, { size: 16 }),
          submenu: rows.remotes.map((row) => ({ id: `remove:${row.id}`, label: row.name, icon: h(DeviceGlyph, { color: deviceColor(row.id) }) })),
        });
      }
      return h(UI.Menu, {
        open,
        anchor: null,
        anchorRef,
        portal: true,
        side: 'top',
        align: 'start',
        autoFocus: keyboard === true,
        minWidthFromAnchor: true,
        returnFocus: returnFocus ?? undefined,
        isExternalTrigger: (node) => node instanceof Element && node.closest(`.${PREFIX}-sw, .${PREFIX}-chip`) !== null,
        onClose,
        items: [{ type: 'label', id: 'heading', text: t('devicesMenu') }],
        footer,
        onSelect: (id) => {
          onClose();
          if (id === 'add') onAdd();
          else if (id.startsWith('remove:')) onRemove(id.slice('remove:'.length));
        },
      },
      rows.local === null ? null : h(UI.MenuItemButton, {
        icon: h(DeviceGlyph, { color: deviceColor(rows.local.id) }),
        current: rows.local.current,
        onSelect: () => { onClose(); onLocal(); },
      }, h(MenuRowContent, { name: t('thisDevice'), meta: rows.local.name, current: rows.local.current })),
      ...rows.remotes.map((row) => h(UI.MenuItemButton, {
        key: row.id,
        icon: h(DeviceGlyph, { tone: row.tone, color: deviceColor(row.id) }),
        current: row.current,
        onSelect: () => { onClose(); onRow(row); },
      }, h(MenuRowContent, { name: row.name, meta: row.meta, metaTone: row.metaTone, current: row.current, busy: row.busy }))));
    }

    /** The top window's menu, anchored to the trigger rectangle it was opened from. */
    function StageMenu({ state, closeMenu, runRow, switchTo, openAdd, openRemove, t }) {
      const anchorRef = useRef(null);
      const rect = state.menu?.rect ?? { left: 0, top: 0, width: 0, height: 0 };
      return h(React.Fragment, null,
        h('span', { ref: anchorRef, className: `${PREFIX}-anchor`, style: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } }),
        h(DeviceMenu, {
          open: state.menu !== null,
          anchorRef,
          rows: deviceRows(state, t),
          keyboard: state.menu?.keyboard,
          returnFocus: state.menu?.returnFocus,
          onClose: closeMenu,
          onLocal: () => { switchTo(null); },
          onRow: (row) => { runRow(row.id, row.action); },
          onAdd: () => { openAdd(); },
          onRemove: openRemove,
          t,
        }));
    }

    function AddDeviceDialog({ add, local, addDevice, closeAdd, t }) {
      const [code, setCode] = useState('');
      const [name, setName] = useState(local?.name ?? '');
      const [now, setNow] = useState(() => Date.now());
      useEffect(() => {
        const timer = setInterval(() => { setNow(Date.now()); }, 15_000);
        return () => { clearInterval(timer); };
      }, []);
      const preview = useMemo(() => previewPairing(code), [code, now]);
      let hint = '';
      let tone;
      if (add.error) { hint = add.error; tone = 'error'; }
      else if (preview?.valid === false) { hint = t('linkInvalid'); tone = 'error'; }
      else if (preview?.expired) { hint = t('linkExpired'); tone = 'error'; }
      else if (preview?.valid) { hint = fill(t('linkPreview'), { host: preview.host, time: formatTime(preview.expiresAt) }); tone = 'ok'; }
      const ready = preview?.valid === true && !preview.expired && !add.busy;
      const submit = () => { if (ready) addDevice(code.trim(), name.trim()); };
      return h(UI.Modal, {
        open: true,
        className: `${PREFIX}-dialog`,
        title: add.readd ? `${t('readdDevice')} · ${add.readd.name}` : t('addTitle'),
        closeLabel: t('close'),
        description: t('addIntro'),
        onClose: closeAdd,
        footer: h(React.Fragment, null,
          h(UI.Button, { variant: 'outline', size: 'sm', onClick: closeAdd, disabled: add.busy }, t('cancel')),
          h(UI.Button, { variant: 'primary', size: 'sm', onClick: submit, disabled: !ready }, add.busy ? t('adding') : t('addAction'))),
      },
      h('form', { className: `${PREFIX}-form`, onSubmit: (event) => { event.preventDefault(); submit(); } },
        h('label', { className: `${PREFIX}-field` },
          h('span', { className: `${PREFIX}-field-label` }, t('linkLabel')),
          h('input', {
            className: `${PREFIX}-input ${PREFIX}-mono`,
            type: 'text',
            value: code,
            placeholder: t('linkPlaceholder'),
            spellCheck: false,
            autoComplete: 'off',
            'data-modal-autofocus': true,
            disabled: add.busy,
            onChange: (event) => { setCode(event.target.value); },
          }),
          h('span', { className: `${PREFIX}-hint`, 'data-tone': tone, role: tone === 'error' ? 'alert' : undefined },
            tone === 'ok' && !add.error ? h(DeviceGlyph, { size: 14, color: deviceColor(preview.serverId) }) : null,
            hint)),
        h('label', { className: `${PREFIX}-field` },
          h('span', { className: `${PREFIX}-field-label` }, t('nameLabel')),
          h('input', { className: `${PREFIX}-input`, type: 'text', value: name, maxLength: 80, disabled: add.busy, onChange: (event) => { setName(event.target.value); } })),
        h('div', { className: `${PREFIX}-note`, style: { margin: 0 } }, t('addRisk')),
        h('button', { type: 'submit', hidden: true })));
    }

    function RemoveDeviceDialog({ removal, remove, closeRemove, t }) {
      const name = removal.name;
      return h(UI.Modal, {
        open: true,
        tone: 'warning',
        className: `${PREFIX}-dialog`,
        title: fill(t(removal.unconfirmed ? 'removedTitle' : 'removeTitle'), { name }),
        closeLabel: t('close'),
        description: removal.unconfirmed ? fill(t('removeUnconfirmed'), { name }) : fill(t('removeIntro'), { name }),
        onClose: closeRemove,
        footer: removal.unconfirmed
          ? h(UI.Button, { variant: 'primary', size: 'sm', 'data-modal-autofocus': true, onClick: closeRemove }, t('gotIt'))
          : h(React.Fragment, null,
            h(UI.Button, { variant: 'outline', size: 'sm', 'data-modal-autofocus': true, onClick: closeRemove, disabled: removal.busy }, t('cancel')),
            h(UI.Button, { variant: 'primary', size: 'sm', onClick: remove, disabled: removal.busy }, removal.busy ? t('removing') : t('remove'))),
      },
      removal.error ? h('p', { className: `${PREFIX}-error`, role: 'alert', style: { margin: 0 } }, fill(t('removeFailed'), { error: removal.error })) : undefined);
    }

    /**
     * Makes the native window read the document's app-regions again. Electron recollects them only
     * when a computed app-region value changes (electron#32341), so this box, which has no area,
     * changes its own value for one frame whenever the surface shown in the window changes.
     */
    function RegionPulse({ token }) {
      const ref = useRef(null);
      useEffect(() => {
        const element = ref.current;
        if (element === null) return undefined;
        element.style.setProperty('-webkit-app-region', 'no-drag');
        const frame = requestAnimationFrame(() => { element.style.removeProperty('-webkit-app-region'); });
        return () => {
          cancelAnimationFrame(frame);
          element.style.removeProperty('-webkit-app-region');
        };
      }, [token]);
      return h('i', { ref, className: `${PREFIX}-pulse`, 'aria-hidden': true });
    }

    /** Layer of the top window above its own frame: device views, the menu, and the add dialog. */
    function SwitcherStage(props) {
      const { t } = props;
      const state = props.useSwitcher((snapshot) => snapshot);
      if (state.mode !== 'top') return null;
      const current = state.current === null ? undefined : state.views[state.current];
      const showChip = current !== undefined && !current.hello;
      // A menu or dialog of this window covers the view; nothing under it may drag the window.
      const covered = state.menu !== null || state.add !== null || state.removal !== null;
      const drag = current !== undefined && !covered && Array.isArray(current.drag) ? current.drag : [];
      // A device without this plugin version never reports its chrome rows; keep a narrow strip so
      // the window can still be moved.
      const fallback = current !== undefined && !covered && !Array.isArray(current.drag);
      return ReactDOM.createPortal(h('div', { className: `${PREFIX}-stage` },
        h('style', null, CSS),
        Object.entries(state.views).filter(([, view]) => view.src !== null).map(([id, view]) => h('iframe', {
          key: id,
          ref: (element) => { props.registerFrame(id, element); },
          className: `${PREFIX}-frame`,
          'data-current': id === state.current ? true : undefined,
          src: view.src,
          title: state.remotes.find((remote) => remote.id === id)?.name ?? '',
          allow: 'clipboard-read; clipboard-write; microphone; fullscreen',
          sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals',
          'aria-hidden': id === state.current ? undefined : true,
          tabIndex: id === state.current ? 0 : -1,
          onLoad: () => { props.frameLoaded(id); },
        })),
        drag.map((rect, index) => h('div', {
          key: index,
          className: `${PREFIX}-drag`,
          'data-window-drag': '',
          'aria-hidden': true,
          style: { left: rect[0], top: rect[1], width: rect[2] - rect[0], height: rect[3] - rect[1] },
        })),
        fallback ? h('div', { className: `${PREFIX}-drag-fallback`, 'data-window-drag': '', 'aria-hidden': true }) : null,
        h(RegionPulse, { token: `${state.current ?? ''}|${JSON.stringify(drag)}|${fallback}` }),
        showChip
          ? h('button', { type: 'button', className: `${PREFIX}-chip`, onClick: (event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            props.openMenu({ left: rect.left, top: rect.top, width: rect.width, height: rect.height }, { keyboard: event.detail === 0 });
          } }, h(DeviceGlyph, { color: deviceColor(state.current) }), state.remotes.find((remote) => remote.id === state.current)?.name ?? '', h(UI.IconChevronsUpDownOutlineRegular, { size: 14 }))
          : null,
        h(StageMenu, { state, closeMenu: props.closeMenu, runRow: props.runRow, switchTo: props.switchTo, openAdd: props.openAdd, openRemove: props.openRemove, t }),
        state.add !== null ? h(AddDeviceDialog, { add: state.add, local: state.local, addDevice: props.add, closeAdd: props.closeAdd, t }) : null,
        state.removal !== null ? h(RemoveDeviceDialog, { removal: state.removal, remove: props.remove, closeRemove: props.closeRemove, t }) : null),
      document.body);
    }

    return {
      inject: ['slots', 'locale', 'connection', 'configForms'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'remote-relay: dictionaries');
        const switcher = createSwitcher(ctx, t);
        ctx.effect(() => {
          const memory = createSessionMemory(ctx, () => {
            // The phone launcher keeps this page hidden until it shows its starting Session.
            if (window.parent !== window) {
              try { window.parent.postMessage({ channel: BRIDGE, v: BRIDGE_VERSION, type: 'restored' }, '*'); } catch { /* the embedding window is gone */ }
            }
          });
          return () => { memory.dispose(); };
        }, 'remote-relay: last opened session');
        ctx.effect(() => () => { switcher.dispose(); }, 'remote-relay: device switcher');
        const controller = createController(ctx);
        ctx.effect(() => () => { controller.dispose(); }, 'remote-relay: controller');
        ctx.effect(() => {
          const off = ctx.on('connection/reset', () => { controller.refresh(); switcher.refresh(); });
          return () => { off(); };
        }, 'remote-relay: reconnect refresh');
        ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'remote-relay.switcher',
          order: 100,
          label: () => t('switcher'),
          locale: NS,
          inject: () => switcher.face,
        }, SwitcherButton)), 'remote-relay: switcher trigger');
        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'remote-relay.stage',
          locale: NS,
          inject: () => switcher.face,
        }, SwitcherStage)), 'remote-relay: device stage');
        ctx.effect(() => ctx.configForms.whileServed([NAMESPACE], () => {
          const offSection = ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'remote-relay',
            order: 60,
            label: () => t('nav'),
            locale: NS,
            inject: () => controller.face,
          }, RemoteAccessSection));
          const offIcon = ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
            name: 'settings.section.icon',
            id: 'remote-relay',
          }, SectionIcon));
          return () => { offSection(); offIcon(); };
        }), 'remote-relay: settings section');
      },
    };
  },
});
