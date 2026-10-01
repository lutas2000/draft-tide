// Who is on the other end of a Unix-domain socket (macOS)?
//
// The kernel records the peer's audit token when it connects
// (getsockopt LOCAL_PEERTOKEN). The token names one process *instance*: it
// carries a pid version that changes on exec, unlike a bare pid. We turn it
// into a SecCode and check a code-signing requirement against it.
//
// For comparison, checkByPid() does the same lookup from LOCAL_PEERPID, the
// pattern the exec-race check shows to be unsafe.
//
// Built with clang directly (no node-gyp); see src/build.ts.
#include <node_api.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/ucred.h>
#include <bsm/libbsm.h>
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <stdio.h>
#include <string.h>

#ifndef LOCAL_PEERTOKEN
#define LOCAL_PEERTOKEN 0x006
#endif

#define CHECK_NAPI(call) do { if ((call) != napi_ok) { napi_throw_error(env, NULL, #call " failed"); return NULL; } } while (0)

static void set_str(napi_env env, napi_value obj, const char *key, const char *val) {
  napi_value v;
  if (val) napi_create_string_utf8(env, val, NAPI_AUTO_LENGTH, &v);
  else napi_get_null(env, &v);
  napi_set_named_property(env, obj, key, v);
}

static void set_int(napi_env env, napi_value obj, const char *key, int64_t n) {
  napi_value v;
  napi_create_int64(env, n, &v);
  napi_set_named_property(env, obj, key, v);
}

static void set_bool(napi_env env, napi_value obj, const char *key, bool b) {
  napi_value v;
  napi_get_boolean(env, b, &v);
  napi_set_named_property(env, obj, key, v);
}

static void cfstr(CFStringRef s, char *out, size_t cap) {
  out[0] = 0;
  if (s) CFStringGetCString(s, out, (CFIndex)cap, kCFStringEncodingUTF8);
}

static int arg_fd(napi_env env, napi_callback_info info, size_t want, napi_value *argv) {
  size_t argc = want;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) return -1;
  int32_t fd = -1;
  if (napi_get_value_int32(env, argv[0], &fd) != napi_ok) return -1;
  return fd;
}

static int peer_token(int fd, audit_token_t *tok) {
  socklen_t len = sizeof(*tok);
  return getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, tok, &len);
}

// peerInfo(fd) -> { pid, euid, pidversion, localPeerPid }
static napi_value peer_info(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  int fd = arg_fd(env, info, 1, argv);
  if (fd < 0) { napi_throw_type_error(env, NULL, "fd required"); return NULL; }
  audit_token_t tok;
  if (peer_token(fd, &tok) != 0) { napi_throw_error(env, NULL, "LOCAL_PEERTOKEN failed"); return NULL; }
  pid_t lpid = 0;
  socklen_t plen = sizeof(lpid);
  getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &lpid, &plen);
  napi_value out;
  CHECK_NAPI(napi_create_object(env, &out));
  set_int(env, out, "pid", audit_token_to_pid(tok));
  set_int(env, out, "euid", audit_token_to_euid(tok));
  set_int(env, out, "pidversion", audit_token_to_pidversion(tok));
  set_int(env, out, "localPeerPid", lpid);
  return out;
}

// Shared tail: given attributes that name a guest, report identity and
// whether it satisfies `requirement`.
static napi_value check_with_attrs(napi_env env, CFDictionaryRef attrs, const char *requirement) {
  napi_value out;
  CHECK_NAPI(napi_create_object(env, &out));
  SecCodeRef code = NULL;
  OSStatus st = SecCodeCopyGuestWithAttributes(NULL, attrs, kSecCSDefaultFlags, &code);
  set_int(env, out, "lookupStatus", st);
  if (st != errSecSuccess || !code) {
    char msg[256];
    CFStringRef m = SecCopyErrorMessageString(st, NULL);
    cfstr(m, msg, sizeof msg);
    if (m) CFRelease(m);
    set_str(env, out, "lookupError", msg);
    set_bool(env, out, "valid", false);
    return out;
  }

  SecStaticCodeRef sc = NULL;
  if (SecCodeCopyStaticCode(code, kSecCSDefaultFlags, &sc) == errSecSuccess && sc) {
    CFDictionaryRef si = NULL;
    if (SecCodeCopySigningInformation(sc, kSecCSSigningInformation, &si) == errSecSuccess && si) {
      char buf[512];
      cfstr((CFStringRef)CFDictionaryGetValue(si, kSecCodeInfoIdentifier), buf, sizeof buf);
      set_str(env, out, "identifier", buf[0] ? buf : NULL);
      cfstr((CFStringRef)CFDictionaryGetValue(si, kSecCodeInfoTeamIdentifier), buf, sizeof buf);
      set_str(env, out, "teamId", buf[0] ? buf : NULL);
      CFNumberRef flags = (CFNumberRef)CFDictionaryGetValue(si, kSecCodeInfoFlags);
      uint32_t f = 0;
      if (flags) CFNumberGetValue(flags, kCFNumberSInt32Type, &f);
      set_int(env, out, "flags", f);
      set_bool(env, out, "adhoc", (f & 0x2) != 0);
      CFDataRef uniq = (CFDataRef)CFDictionaryGetValue(si, kSecCodeInfoUnique);
      if (uniq) {
        char hex[2 * 32 + 1] = {0};
        CFIndex n = CFDataGetLength(uniq);
        if (n > 32) n = 32;
        const UInt8 *p = CFDataGetBytePtr(uniq);
        for (CFIndex i = 0; i < n; i++) snprintf(hex + 2 * i, 3, "%02x", p[i]);
        set_str(env, out, "cdhash", hex);
      }
      CFRelease(si);
    }
    CFURLRef url = NULL;
    if (SecCodeCopyPath(sc, kSecCSDefaultFlags, &url) == errSecSuccess && url) {
      char path[1024];
      if (CFURLGetFileSystemRepresentation(url, true, (UInt8 *)path, sizeof path)) set_str(env, out, "path", path);
      CFRelease(url);
    }
    CFRelease(sc);
  }

  if (requirement) {
    CFStringRef rs = CFStringCreateWithCString(NULL, requirement, kCFStringEncodingUTF8);
    SecRequirementRef req = NULL;
    OSStatus rst = SecRequirementCreateWithString(rs, kSecCSDefaultFlags, &req);
    CFRelease(rs);
    if (rst != errSecSuccess) {
      set_int(env, out, "requirementStatus", rst);
      set_bool(env, out, "valid", false);
    } else {
      OSStatus vst = SecCodeCheckValidity(code, kSecCSDefaultFlags, req);
      set_int(env, out, "checkStatus", vst);
      set_bool(env, out, "valid", vst == errSecSuccess);
      CFRelease(req);
    }
  }
  CFRelease(code);
  return out;
}

static char *arg_string(napi_env env, napi_value v) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, v, NULL, 0, &len) != napi_ok) return NULL;
  char *s = (char *)malloc(len + 1);
  napi_get_value_string_utf8(env, v, s, len + 1, &len);
  return s;
}

// checkByToken(fd, requirement) — the safe pattern.
static napi_value check_by_token(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  int fd = arg_fd(env, info, 2, argv);
  if (fd < 0) { napi_throw_type_error(env, NULL, "fd required"); return NULL; }
  audit_token_t tok;
  if (peer_token(fd, &tok) != 0) { napi_throw_error(env, NULL, "LOCAL_PEERTOKEN failed"); return NULL; }
  char *req = arg_string(env, argv[1]);
  CFDataRef data = CFDataCreate(NULL, (const UInt8 *)&tok, sizeof tok);
  const void *keys[] = { kSecGuestAttributeAudit };
  const void *vals[] = { data };
  CFDictionaryRef attrs = CFDictionaryCreate(NULL, keys, vals, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  napi_value out = check_with_attrs(env, attrs, req);
  CFRelease(attrs);
  CFRelease(data);
  free(req);
  return out;
}

// checkByPid(fd, requirement) — looks the peer up by LOCAL_PEERPID. Unsafe:
// the pid can exec into different code after connecting.
static napi_value check_by_pid(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  int fd = arg_fd(env, info, 2, argv);
  if (fd < 0) { napi_throw_type_error(env, NULL, "fd required"); return NULL; }
  pid_t pid = 0;
  socklen_t plen = sizeof(pid);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &plen) != 0) { napi_throw_error(env, NULL, "LOCAL_PEERPID failed"); return NULL; }
  char *req = arg_string(env, argv[1]);
  CFNumberRef num = CFNumberCreate(NULL, kCFNumberIntType, &pid);
  const void *keys[] = { kSecGuestAttributePid };
  const void *vals[] = { num };
  CFDictionaryRef attrs = CFDictionaryCreate(NULL, keys, vals, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  napi_value out = check_with_attrs(env, attrs, req);
  CFRelease(attrs);
  CFRelease(num);
  free(req);
  return out;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    { "peerInfo", NULL, peer_info, NULL, NULL, NULL, napi_default, NULL },
    { "checkByToken", NULL, check_by_token, NULL, NULL, NULL, napi_default, NULL },
    { "checkByPid", NULL, check_by_pid, NULL, NULL, NULL, napi_default, NULL },
  };
  napi_define_properties(env, exports, sizeof props / sizeof props[0], props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
