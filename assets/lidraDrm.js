/**
 * Lidra page shim.
 *
 * The page's player only starts a stream once it believes it has a CDM. Lidra
 * decrypts outside the browser, so this shim answers EME capability probes and
 * synthesises a key session that reports its keys as usable. No licence request
 * is ever sent, and the media element is never handed real encrypted bytes: the
 * manifest redirect in the main process points the player at the local pipeline,
 * which serves plain fMP4.
 *
 * Everything is patched behind `__LIDRA_EME__` so a future Apple change can be
 * disabled from Settings without rebuilding.
 */
(function () {
  if (!__LIDRA_EME__) return;
  if (window.__lidraEmeInstalled) return;
  window.__lidraEmeInstalled = true;

  var LOG = "[Lidra]";
  var KEY_SYSTEMS = [
    "com.widevine.alpha",
    "com.apple.fps",
    "com.apple.fps.1_0",
    "com.apple.fps.2_0",
    "org.w3.clearkey",
  ];

  function KeyStatusMap(entries) {
    this._entries = entries || [];
  }
  KeyStatusMap.prototype.get = function (keyId) {
    for (var i = 0; i < this._entries.length; i += 1) {
      if (sameKey(this._entries[i][0], keyId)) return this._entries[i][1];
    }
    return undefined;
  };
  KeyStatusMap.prototype.has = function (keyId) {
    return this.get(keyId) !== undefined;
  };
  KeyStatusMap.prototype.forEach = function (callback, thisArg) {
    for (var i = 0; i < this._entries.length; i += 1) {
      callback.call(thisArg, this._entries[i][1], this._entries[i][0], this);
    }
  };
  KeyStatusMap.prototype.entries = function () {
    return this._entries.slice()[Symbol.iterator]();
  };
  Object.defineProperty(KeyStatusMap.prototype, "size", {
    get: function () {
      return this._entries.length;
    },
  });

  function sameKey(left, right) {
    try {
      var a = new Uint8Array(left);
      var b = new Uint8Array(right);
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
      return true;
    } catch (error) {
      return false;
    }
  }

  function randomId() {
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.prototype.map
      .call(bytes, function (byte) {
        return ("0" + byte.toString(16)).slice(-2);
      })
      .join("");
  }

  function FakeMediaKeySession() {
    EventTarget.call(this);
    this.sessionId = randomId();
    this.expiration = NaN;
    this.closed = new Promise(function () {});
    this.keyStatuses = new KeyStatusMap();
    this._keys = [];
  }
  FakeMediaKeySession.prototype = Object.create(EventTarget.prototype);
  FakeMediaKeySession.prototype.constructor = FakeMediaKeySession;

  FakeMediaKeySession.prototype.generateRequest = function (initDataType, initData) {
    var session = this;
    return Promise.resolve().then(function () {
      // The page waits for a licence request event before it calls update().
      var event = new Event("message");
      event.messageType = "license-request";
      event.message = initData || new ArrayBuffer(0);
      session.dispatchEvent(event);
    });
  };

  // The player asks about the KIDs it saw in the init segment. Lidra never sees
  // those boxes any more (its media is plain), so every queried KID answers
  // "usable" instead of trying to enumerate them.
  function UsableKeyStatusMap() {}
  UsableKeyStatusMap.prototype.get = function () {
    return "usable";
  };
  UsableKeyStatusMap.prototype.has = function () {
    return true;
  };
  UsableKeyStatusMap.prototype.forEach = function (callback, thisArg) {
    callback.call(thisArg, "usable", new ArrayBuffer(16), this);
  };
  UsableKeyStatusMap.prototype.entries = function () {
    return [[new ArrayBuffer(16), "usable"]][Symbol.iterator]();
  };
  Object.defineProperty(UsableKeyStatusMap.prototype, "size", {
    get: function () {
      return 1;
    },
  });

  FakeMediaKeySession.prototype.update = function () {
    var session = this;
    return Promise.resolve().then(function () {
      session.keyStatuses = new UsableKeyStatusMap();
      session.dispatchEvent(new Event("keystatuseschange"));
    });
  };

  FakeMediaKeySession.prototype.load = function () {
    return Promise.resolve(false);
  };
  FakeMediaKeySession.prototype.remove = function () {
    return Promise.resolve();
  };
  FakeMediaKeySession.prototype.close = function () {
    var session = this;
    return Promise.resolve().then(function () {
      session.dispatchEvent(new Event("keystatuseschange"));
    });
  };

  function FakeMediaKeys(keySystem) {
    this.keySystem = keySystem;
    this._sessions = [];
  }
  FakeMediaKeys.prototype.createSession = function () {
    var session = new FakeMediaKeySession();
    this._sessions.push(session);
    return session;
  };
  FakeMediaKeys.prototype.setServerCertificate = function () {
    return Promise.resolve(true);
  };
  FakeMediaKeys.prototype.getStatusForPolicy = function () {
    return Promise.resolve("usable");
  };

  function FakeAccess(keySystem, configuration) {
    this.keySystem = keySystem;
    this._configuration = configuration;
  }
  FakeAccess.prototype.getConfiguration = function () {
    return this._configuration;
  };
  FakeAccess.prototype.createMediaKeys = function () {
    return Promise.resolve(new FakeMediaKeys(this.keySystem));
  };

  var originalRequest = navigator.requestMediaKeySystemAccess
    ? navigator.requestMediaKeySystemAccess.bind(navigator)
    : null;

  navigator.requestMediaKeySystemAccess = function (keySystem, configurations) {
    if (KEY_SYSTEMS.indexOf(keySystem) === -1) {
      return originalRequest
        ? originalRequest(keySystem, configurations)
        : Promise.reject(
            new DOMException("Unsupported key system: " + keySystem, "NotSupportedError"),
          );
    }
    var configuration = (configurations && configurations[0]) || {
      initDataTypes: ["cenc"],
      audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
    };
    console.log(LOG, "EME access granted for", keySystem);
    return Promise.resolve(new FakeAccess(keySystem, configuration));
  };

  // A synthetic MediaKeys object cannot be attached through the real binding.
  var originalSetMediaKeys = HTMLMediaElement.prototype.setMediaKeys;
  HTMLMediaElement.prototype.setMediaKeys = function (mediaKeys) {
    if (mediaKeys && mediaKeys instanceof FakeMediaKeys) {
      this.__lidraMediaKeys = mediaKeys;
      return Promise.resolve();
    }
    return originalSetMediaKeys
      ? originalSetMediaKeys.call(this, mediaKeys)
      : Promise.resolve();
  };

  Object.defineProperty(HTMLMediaElement.prototype, "mediaKeys", {
    configurable: true,
    get: function () {
      return this.__lidraMediaKeys || null;
    },
  });

  if (navigator.mediaCapabilities && navigator.mediaCapabilities.decodingInfo) {
    var originalDecodingInfo = navigator.mediaCapabilities.decodingInfo.bind(
      navigator.mediaCapabilities,
    );
    navigator.mediaCapabilities.decodingInfo = function (configuration) {
      var audio = configuration && configuration.audio;
      var encrypted =
        audio && audio.robustness && audio.robustness !== "";
      if (encrypted) {
        return Promise.resolve({
          supported: true,
          smooth: true,
          powerEfficient: true,
          keySystemAccess: new FakeAccess("com.widevine.alpha", {
            initDataTypes: ["cenc"],
            audioCapabilities: [{}],
          }),
        });
      }
      return originalDecodingInfo(configuration);
    };
  }

  console.log(LOG, "EME shim installed");
})();
