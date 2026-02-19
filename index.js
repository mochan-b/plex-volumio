'use strict';

var libQ = require('kew');
var vconf = require('v-conf');

module.exports = ControllerPlex;

function ControllerPlex(context) {
  this.context = context;
  this.commandRouter = context.coreCommand;
  this.logger = context.logger;
  this.configManager = context.configManager;
  this.config = new vconf();
  this.adapter = null;
}

ControllerPlex.prototype.onVolumioStart = function () {
  var configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
  this.config.loadFile(configFile);

  var host = this.config.get('host') || '';
  var port = this.config.get('port') || 32400;
  var token = this.config.get('token') || '';
  var https = this.config.get('https') || false;
  var shuffle = this.config.get('shuffle') || false;
  var pageSize = this.config.get('pageSize') || 100;
  var gaplessPlayback = this.config.get('gaplessPlayback') !== false;
  var crossfadeEnabled = this.config.get('crossfadeEnabled') || false;
  var crossfadeDuration = this.config.get('crossfadeDuration') || 5;

  this._initAdapter(host, port, token, https, shuffle, pageSize, gaplessPlayback, crossfadeEnabled, crossfadeDuration);

  return libQ.resolve();
};

ControllerPlex.prototype.onStart = function () {
  if (this.adapter) {
    this.adapter.onStart();
  }
  return libQ.resolve();
};

ControllerPlex.prototype.onStop = function () {
  if (this.adapter) {
    this.adapter.onStop();
  }
  return libQ.resolve();
};

ControllerPlex.prototype.getConfigurationFiles = function () {
  return ['config.json'];
};

// ── UI Config ───────────────────────────────────────────────────────

ControllerPlex.prototype.getUIConfig = function () {
  var defer = libQ.defer();
  var self = this;
  var lang_code = this.commandRouter.sharedVars.get('language_code');

  this.commandRouter.i18nJson(
    __dirname + '/i18n/strings_' + lang_code + '.json',
    __dirname + '/i18n/strings_en.json',
    __dirname + '/UIConfig.json'
  )
    .then(function (uiconf) {
      uiconf.sections[0].content[0].value = self.config.get('host') || '';
      uiconf.sections[0].content[1].value = self.config.get('port') || 32400;
      uiconf.sections[0].content[2].value = self.config.get('token') || '';
      uiconf.sections[0].content[3].value = self.config.get('https') || false;
      uiconf.sections[1].content[0].value = self.config.get('shuffle') || false;
      uiconf.sections[1].content[1].value = self.config.get('pageSize') || 100;
      uiconf.sections[2].content[0].value = self.config.get('gaplessPlayback') !== false;
      uiconf.sections[2].content[1].value = self.config.get('crossfadeEnabled') || false;
      uiconf.sections[2].content[2].value = self.config.get('crossfadeDuration') || 5;
      defer.resolve(uiconf);
    })
    .fail(function (error) {
      self.logger.error('[Plex] Failed to load UI config: ' + error);
      defer.reject(error);
    });

  return defer.promise;
};

ControllerPlex.prototype.saveConfig = function (data) {
  var safeData = Object.assign({}, data);
  if (safeData.token) {
    safeData.token = typeof safeData.token === 'object'
      ? Object.assign({}, safeData.token, { value: '████████' })
      : '████████';
  }
  this.logger.info('[Plex] saveConfig data: ' + JSON.stringify(safeData));

  var host = (data.host && data.host.value !== undefined) ? data.host.value : data.host;
  var port = (data.port && data.port.value !== undefined) ? data.port.value : data.port;
  var token = (data.token && data.token.value !== undefined) ? data.token.value : data.token;
  var https = (data.https && data.https.value !== undefined) ? data.https.value : data.https;

  // v-conf requires port to be a number
  port = Number(port) || 32400;
  https = !!https;

  this.config.set('host', host);
  this.config.set('port', port);
  this.config.set('token', token);
  this.config.set('https', https);

  var shuffle = this.config.get('shuffle') || false;
  var pageSize = this.config.get('pageSize') || 100;
  this._initAdapter(host, port, token, https, shuffle, pageSize);

  this.commandRouter.pushToastMessage('success', 'Plex', 'Configuration saved');
  return libQ.resolve();
};

ControllerPlex.prototype.saveOptions = function (data) {
  this.logger.info('[Plex] saveOptions data: ' + JSON.stringify(data));

  var shuffle = (data.shuffle && data.shuffle.value !== undefined) ? data.shuffle.value : data.shuffle;
  shuffle = !!shuffle;

  var pageSize = (data.pageSize && data.pageSize.value !== undefined) ? data.pageSize.value : data.pageSize;
  pageSize = Number(pageSize) || 100;
  if (pageSize < 10) pageSize = 10;
  if (pageSize > 1000) pageSize = 1000;

  var gaplessPlayback = (data.gaplessPlayback && data.gaplessPlayback.value !== undefined) ? data.gaplessPlayback.value : data.gaplessPlayback;
  gaplessPlayback = gaplessPlayback !== false;

  var crossfadeEnabled = (data.crossfadeEnabled && data.crossfadeEnabled.value !== undefined) ? data.crossfadeEnabled.value : data.crossfadeEnabled;
  crossfadeEnabled = !!crossfadeEnabled;

  var crossfadeDuration = (data.crossfadeDuration && data.crossfadeDuration.value !== undefined) ? data.crossfadeDuration.value : data.crossfadeDuration;
  crossfadeDuration = Number(crossfadeDuration) || 5;
  if (crossfadeDuration < 1) crossfadeDuration = 1;
  if (crossfadeDuration > 12) crossfadeDuration = 12;

  this.config.set('shuffle', shuffle);
  this.config.set('pageSize', pageSize);
  this.config.set('gaplessPlayback', gaplessPlayback);
  this.config.set('crossfadeEnabled', crossfadeEnabled);
  this.config.set('crossfadeDuration', crossfadeDuration);

  var host = this.config.get('host') || '';
  var port = this.config.get('port') || 32400;
  var token = this.config.get('token') || '';
  var https = this.config.get('https') || false;

  this._initAdapter(host, port, token, https, shuffle, pageSize, gaplessPlayback, crossfadeEnabled, crossfadeDuration);

  this.commandRouter.pushToastMessage('success', 'Plex', 'Options saved');
  return libQ.resolve();
};

// ── Browse ──────────────────────────────────────────────────────────

ControllerPlex.prototype.handleBrowseUri = function (uri) {
  if (!this.adapter) {
    return libQ.reject(new Error('Plex plugin not initialized'));
  }
  return this.adapter.handleBrowseUri(uri);
};

// ── Explode ─────────────────────────────────────────────────────────

ControllerPlex.prototype.explodeUri = function (uri) {
  if (!this.adapter) {
    return libQ.reject(new Error('Plex plugin not initialized'));
  }
  return this.adapter.explodeUri(uri);
};

// ── Playback ────────────────────────────────────────────────────────

ControllerPlex.prototype.clearAddPlayTrack = function (track) {
  if (!this.adapter) {
    return libQ.reject(new Error('Plex plugin not initialized'));
  }
  return this.adapter.clearAddPlayTrack(track);
};

ControllerPlex.prototype.prefetch = function (track) {
  if (!this.adapter) {
    return libQ.reject(new Error('Plex plugin not initialized'));
  }
  return this.adapter.prefetch(track);
};

ControllerPlex.prototype.stop = function () {
  if (!this.adapter) {
    return libQ.reject(new Error('Plex plugin not initialized'));
  }
  return this.adapter.stop();
};

ControllerPlex.prototype.pause = function () {
  if (!this.adapter) {
    return libQ.reject(new Error('Plex plugin not initialized'));
  }
  return this.adapter.pause();
};

ControllerPlex.prototype.resume = function () {
  if (!this.adapter) {
    return libQ.reject(new Error('Plex plugin not initialized'));
  }
  return this.adapter.resume();
};

ControllerPlex.prototype.seek = function (position) {
  if (!this.adapter) {
    return libQ.reject(new Error('Plex plugin not initialized'));
  }
  return this.adapter.seek(position);
};

ControllerPlex.prototype.next = function () {
  if (!this.adapter) {
    return libQ.reject(new Error('Plex plugin not initialized'));
  }
  return this.adapter.next();
};

ControllerPlex.prototype.previous = function () {
  if (!this.adapter) {
    return libQ.reject(new Error('Plex plugin not initialized'));
  }
  return this.adapter.previous();
};

// ── Search ──────────────────────────────────────────────────────────

ControllerPlex.prototype.search = function (query) {
  if (!this.adapter) {
    return libQ.reject(new Error('Plex plugin not initialized'));
  }
  return this.adapter.search(query);
};

// ── Goto ────────────────────────────────────────────────────────────

ControllerPlex.prototype.goto = function (data) {
  if (!this.adapter) {
    return libQ.reject(new Error('Plex plugin not initialized'));
  }
  return this.adapter.goto(data);
};

// ── Internal ────────────────────────────────────────────────────────

ControllerPlex.prototype._initAdapter = function (host, port, token, https, shuffle, pageSize, gaplessPlayback, crossfadeEnabled, crossfadeDuration) {
  var compiled = require('./dist/index.js');
  var VolumioAdapter = compiled.VolumioAdapter;
  var PlexApiClient = compiled.PlexApiClient;
  var PlexService = compiled.PlexService;

  var connection = { host: host, port: port, token: token, https: !!https };
  var apiClient = new PlexApiClient(connection);
  var plexService = new PlexService(apiClient, connection);

  this.adapter = new VolumioAdapter(this.context, libQ);
  this.adapter.configure(plexService, connection, {
    shuffle: !!shuffle,
    pageSize: Number(pageSize) || 100,
    gaplessPlayback: gaplessPlayback !== false,
    crossfadeEnabled: !!crossfadeEnabled,
    crossfadeDuration: Number(crossfadeDuration) || 5,
  });
};
