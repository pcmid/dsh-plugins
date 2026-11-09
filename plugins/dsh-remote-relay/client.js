window.__ModuleLoader__.load({
  id: '@pcmid/dsh-remote-relay',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useMemo, useState } = React;

    const NS = 'settings.remoteRelay';
    const NAMESPACE = 'remote-relay';
    const CHANNEL = '/api';
    const ENDPOINT = 'remote-relay';
    const PREFIX = 'dsh-rr';
    const POLL_MS = 2000;
    const NOTICE_MS = 1600;

    const zh = {
      nav: '远程访问',
      lead: '通过自建的 OpenChamber relay，从手机或其他电脑使用这个 DSH。数据端到端加密，relay 只转发密文。',
      enable: '启用远程访问',
      enableTip: '开启后，DSH 会保持与 relay 的连接，已配对的设备可以随时连进来。',
      status: '状态',
      relay: 'Relay 地址',
      relayTip: '自建 relay 的 WebSocket 地址，例如 wss://relay.example.com/ws。只写域名时会自动补全。',
      relayPlaceholder: 'wss://relay.example.com/ws',
      launcher: '启动页地址',
      launcherTip: '部署了本插件 launcher 目录的 HTTPS 地址。手机扫码后打开它；不填则只能用电脑连接器配对。',
      launcherPlaceholder: 'https://remote.example.com/',
      hostName: '主机名称',
      hostNameTip: '在已配对设备上显示的名称。',
      save: '保存',
      saved: '已保存',
      saveFailed: '保存失败',
      pairHeading: '配对新设备',
      pairIntro: '手机扫描二维码打开启动页；电脑使用 dsh-remote 连接器。配对码只能使用一次。',
      pairAction: '配对新设备',
      pairNeedsOnline: '启用远程访问并连上 relay 后才能配对。',
      scan: '用手机相机扫描',
      link: '手机链接',
      connector: '电脑连接器',
      connectorTip: '在要连接的电脑上运行（需要 Node 22 或更高版本），之后运行 node dsh-remote.mjs connect。',
      connectorLocal: 'dsh-remote.mjs 位于本插件的 launcher 目录中，也会随启动页一起部署。',
      noLauncher: '还没有填写启动页地址，所以没有手机二维码。',
      copy: '复制',
      copied: '已复制',
      expiresIn: '{time} 后失效',
      cancel: '取消',
      risk: '配对后的设备拥有与你在本机相同的全部权限，包括执行命令和读写文件。只配对你自己的设备；不再使用时请移除。',
      devices: '已配对设备',
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
    };
    const en = {
      nav: 'Remote access',
      lead: 'Use this DSH from your phone or another computer through your self-hosted OpenChamber relay. Traffic is end-to-end encrypted; the relay only forwards ciphertext.',
      enable: 'Enable remote access',
      enableTip: 'While on, DSH stays connected to the relay so paired devices can reach it at any time.',
      status: 'Status',
      relay: 'Relay address',
      relayTip: 'WebSocket address of your relay, such as wss://relay.example.com/ws. A bare host name is completed automatically.',
      relayPlaceholder: 'wss://relay.example.com/ws',
      launcher: 'Launcher address',
      launcherTip: 'HTTPS address where this plugin\'s launcher folder is deployed. Phones open it from the QR code; without it only the computer connector can pair.',
      launcherPlaceholder: 'https://remote.example.com/',
      hostName: 'Host name',
      hostNameTip: 'Name paired devices show for this DSH.',
      save: 'Save',
      saved: 'Saved',
      saveFailed: 'Could not save',
      pairHeading: 'Pair a device',
      pairIntro: 'Phones scan the QR code to open the launcher; computers use the dsh-remote connector. A pairing code works once.',
      pairAction: 'Pair a device',
      pairNeedsOnline: 'Turn on remote access and connect to the relay before pairing.',
      scan: 'Scan with your phone camera',
      link: 'Phone link',
      connector: 'Computer connector',
      connectorTip: 'Run on the computer you want to connect (Node 22 or later), then run node dsh-remote.mjs connect.',
      connectorLocal: 'dsh-remote.mjs is in this plugin\'s launcher folder and is deployed with the launcher.',
      noLauncher: 'No launcher address is set, so there is no phone QR code.',
      copy: 'Copy',
      copied: 'Copied',
      expiresIn: 'Expires in {time}',
      cancel: 'Cancel',
      risk: 'A paired device has the same full authority you have on this computer, including running commands and changing files. Pair only devices you own, and remove them when unused.',
      devices: 'Paired devices',
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
.${PREFIX}-qr { width: 184px; height: 184px; border-radius: var(--dsw-radius-md, 8px); }
.${PREFIX}-fields { flex: 1 1 280px; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.${PREFIX}-field { display: flex; flex-direction: column; gap: 6px; }
.${PREFIX}-field-label { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.${PREFIX}-copy-row { display: flex; gap: 8px; align-items: center; }
.${PREFIX}-copy-row .${PREFIX}-input { max-width: none; }
.${PREFIX}-device { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l1, var(--dsw-alias-border-l2)); }
.${PREFIX}-device:last-child { border-bottom: none; }
.${PREFIX}-device-main { flex: 1; min-width: 0; }
.${PREFIX}-device-name { display: flex; align-items: center; gap: 8px; font-size: 14px; line-height: 20px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${PREFIX}-badge { flex: none; padding: 0 6px; border-radius: 999px; font-size: 11px; line-height: 18px; color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent); }
.${PREFIX}-footer { padding: 12px 0 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
@media (prefers-reduced-motion: reduce) { .${PREFIX}-thumb { transition: none; } }
`;

    // -----------------------------------------------------------------------
    // Controller
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

    function createController(ctx) {
      const form = ctx.configForms.get(NAMESPACE);
      let status = null;
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
          loadFailed,
          actionError,
          busy,
          writes: { ...writes },
        };
      };
      const store = createStore(projection());
      const publish = () => { if (!disposed) store.set(projection()); };
      const offForm = form.subscribe(publish);

      const call = async (endpoint, payload = {}) => {
        const result = await ctx.connection.rpc.call(CHANNEL, `${ENDPOINT}/${endpoint}`, payload);
        if (!result.ok) throw new Error(result.error?.message ?? 'Request failed');
        return result.value;
      };

      const refresh = async () => {
        const current = ++generation;
        try {
          const value = await call('status');
          if (disposed || current !== generation) return;
          status = value;
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
    // Components
    // -----------------------------------------------------------------------

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
        h('span', { className: `${PREFIX}-field-label` }, label),
        h('div', { className: `${PREFIX}-copy-row` },
          h('input', { className: `${PREFIX}-input${mono ? ` ${PREFIX}-mono` : ''}`, type: 'text', readOnly: true, value, 'aria-label': label, onFocus: (event) => { event.target.select(); } }),
          h('button', { type: 'button', className: `${PREFIX}-button`, onClick: async () => { if (await copy(value)) setCopied(true); } }, copied ? t('copied') : t('copy'))));
    }

    function Countdown({ expiresAt, offset, t }) {
      const [now, setNow] = useState(() => Date.now());
      useEffect(() => {
        const timer = setInterval(() => { setNow(Date.now()); }, 1000);
        return () => { clearInterval(timer); };
      }, []);
      const left = Math.max(0, Math.round((expiresAt - now - offset) / 1000));
      const text = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      return h('span', { className: `${PREFIX}-status` }, fill(t('expiresIn'), { time: text }));
    }

    function stateTone(state) {
      if (state === 'online') return 'ok';
      if (state === 'connecting' || state === 'starting' || state === 'unconfigured') return 'warn';
      if (state === 'offline' || state === 'error' || state === 'replaced') return 'error';
      return 'idle';
    }

    function DeviceRow({ device, now, busy, onRevoke, t }) {
      const [confirming, setConfirming] = useState(false);
      useEffect(() => {
        if (!confirming) return undefined;
        const timer = setTimeout(() => { setConfirming(false); }, 4000);
        return () => { clearTimeout(timer); };
      }, [confirming]);
      const details = [fill(t('pairedAt'), { date: formatDate(device.pairedAt) })];
      if (device.lastSeenAt) details.push(fill(t('lastSeen'), { time: formatAgo(device.lastSeenAt, now) }));
      return h('div', { className: `${PREFIX}-device` },
        h('div', { className: `${PREFIX}-device-main` },
          h('div', { className: `${PREFIX}-device-name` }, device.name, device.connections > 0 ? h('span', { className: `${PREFIX}-badge` }, t('online')) : null),
          h('div', { className: `${PREFIX}-desc` }, details.join(' · '))),
        h('button', {
          type: 'button',
          className: `${PREFIX}-button`,
          'data-size': 'small',
          'data-danger': true,
          disabled: busy !== null,
          onClick: () => { if (confirming) onRevoke(device.id); else setConfirming(true); },
        }, confirming ? t('confirmRemove') : t('remove')));
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
      const offset = status ? Date.now() - status.now : 0;
      const editable = state.configReady && state.writable;
      const onlineCount = (status?.devices ?? []).filter((device) => device.connections > 0).length;
      const stateDetail = control === 'online' ? fill(t('onlineDetail'), { count: onlineCount }) : status?.control?.error ?? status?.relayError ?? '';
      const pairing = status?.pairing;
      const launcherBase = (config.launcherUrl ?? '').trim();
      const connectorUrl = launcherBase ? new URL('dsh-remote.mjs', launcherBase.endsWith('/') ? launcherBase : `${launcherBase}/`).href : '';
      const connectorCommand = pairing
        ? `${connectorUrl ? `curl -fsSLO ${connectorUrl} && ` : ''}node dsh-remote.mjs pair '${pairing.code}'`
        : '';
      let launcherValid = true;
      try { if (launcherBase) new URL(launcherBase); } catch { launcherValid = false; }

      return h('div', { className: `${PREFIX}-root` },
        h('style', null, CSS),
        h('p', { className: `${PREFIX}-lead` }, t('lead')),
        h('section', { className: `${PREFIX}-group`, 'aria-label': t('nav') },
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
          h(TextSetting, { field: 'launcherUrl', title: t('launcher'), desc: t('launcherTip'), placeholder: t('launcherPlaceholder'), value: config.launcherUrl ?? '', write: state.writes.launcherUrl, disabled: !editable, onSave: props.setField, t }),
          h(TextSetting, { field: 'hostName', title: t('hostName'), desc: t('hostNameTip'), placeholder: status?.hostName ?? '', value: config.hostName ?? '', write: state.writes.hostName, disabled: !editable, onSave: props.setField, t })),
        h('section', { className: `${PREFIX}-group`, 'aria-labelledby': `${PREFIX}-pair` },
          h('h3', { id: `${PREFIX}-pair`, className: `${PREFIX}-heading` }, t('pairHeading')),
          h('div', { className: `${PREFIX}-desc` }, t('pairIntro')),
          pairing
            ? h('div', { className: `${PREFIX}-pairing` },
              pairing.link
                ? h('div', { className: `${PREFIX}-qr-box` },
                  h(QrCode, { text: pairing.link, label: t('scan') }),
                  h('span', { className: `${PREFIX}-status` }, t('scan')))
                : null,
              h('div', { className: `${PREFIX}-fields` },
                pairing.link
                  ? h(CopyField, { label: t('link'), value: pairing.link, copy: props.copy, t })
                  : h('div', { className: `${PREFIX}-status` }, t('noLauncher')),
                h(CopyField, { label: t('connector'), value: connectorCommand, mono: true, copy: props.copy, t }),
                h('div', { className: `${PREFIX}-desc` }, t('connectorTip'), ' ', connectorUrl ? '' : t('connectorLocal')),
                h('div', { className: `${PREFIX}-copy-row` },
                  h(Countdown, { expiresAt: pairing.expiresAt, offset, t }),
                  h('span', { style: { flex: 1 } }),
                  h('button', { type: 'button', className: `${PREFIX}-button`, 'data-size': 'small', disabled: state.busy !== null, onClick: props.cancelPairing }, t('cancel')))))
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

    return {
      inject: ['slots', 'locale', 'connection', 'configForms'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'remote-relay: dictionaries');
        const controller = createController(ctx);
        ctx.effect(() => () => { controller.dispose(); }, 'remote-relay: controller');
        ctx.effect(() => {
          const off = ctx.on('connection/reset', () => { controller.refresh(); });
          return () => { off(); };
        }, 'remote-relay: reconnect refresh');
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
