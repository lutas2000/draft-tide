// N-API addon: the Engine's GitHub sign-in, one generic password in the
// user's login keychain (CLAUDE.md "Token custody"). In-process on purpose:
// the keychain decides who may read an item by the code signature of the
// calling process, so going through /usr/bin/security would make `security`
// the trusted reader. Created without kSecAttrAccess, the item's default
// access list trusts only the creating program's designated requirement: the
// Engine (a Node SEA under its own identifier in release builds).
//
//   read(service, account)          -> { status, message, data? }
//   write(service, account, label, data: Buffer) -> { status, message }
//   remove(service, account)        -> { status, message }
//
// Nothing here may ever show a dialog: reads and updates run with user
// interaction off and kSecUseAuthenticationUIFail, so an item the caller isn't
// trusted for fails (errSecInteractionNotAllowed, errSecAuthFailed) instead of
// asking the user.
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <node_api.h>
#include <stdlib.h>
#include <string.h>

#pragma clang diagnostic ignored "-Wdeprecated-declarations"

static char *arg_string(napi_env env, napi_value v) {
  size_t n = 0;
  if (napi_get_value_string_utf8(env, v, NULL, 0, &n) != napi_ok) return NULL;
  char *s = malloc(n + 1);
  if (!s) return NULL;
  napi_get_value_string_utf8(env, v, s, n + 1, &n);
  return s;
}

static CFMutableDictionaryRef item_query(const char *service, const char *account) {
  CFMutableDictionaryRef q =
      CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFDictionarySetValue(q, kSecClass, kSecClassGenericPassword);
  CFStringRef s = CFStringCreateWithCString(NULL, service, kCFStringEncodingUTF8);
  CFStringRef a = CFStringCreateWithCString(NULL, account, kCFStringEncodingUTF8);
  CFDictionarySetValue(q, kSecAttrService, s);
  CFDictionarySetValue(q, kSecAttrAccount, a);
  CFRelease(s);
  CFRelease(a);
  return q;
}

static void no_ui(CFMutableDictionaryRef q) {
  CFDictionarySetValue(q, kSecUseAuthenticationUI, kSecUseAuthenticationUIFail);
}

static napi_value result(napi_env env, OSStatus st, CFDataRef data) {
  napi_value out, v;
  napi_create_object(env, &out);
  napi_create_int32(env, st, &v);
  napi_set_named_property(env, out, "status", v);
  char buf[256] = "";
  CFStringRef msg = SecCopyErrorMessageString(st, NULL);
  if (msg) {
    CFStringGetCString(msg, buf, sizeof buf, kCFStringEncodingUTF8);
    CFRelease(msg);
  }
  napi_create_string_utf8(env, buf, NAPI_AUTO_LENGTH, &v);
  napi_set_named_property(env, out, "message", v);
  if (data) {
    void *copy = NULL;
    napi_create_buffer_copy(env, (size_t)CFDataGetLength(data), CFDataGetBytePtr(data), &copy, &v);
    napi_set_named_property(env, out, "data", v);
  }
  return out;
}

static napi_value read_item(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char *service = arg_string(env, argv[0]);
  char *account = arg_string(env, argv[1]);
  if (!service || !account) {
    free(service);
    free(account);
    return result(env, errSecParam, NULL);
  }
  CFMutableDictionaryRef q = item_query(service, account);
  CFDictionarySetValue(q, kSecReturnData, kCFBooleanTrue);
  CFDictionarySetValue(q, kSecMatchLimit, kSecMatchLimitOne);
  no_ui(q);
  SecKeychainSetUserInteractionAllowed(false);
  CFTypeRef found = NULL;
  OSStatus st = SecItemCopyMatching(q, &found);
  SecKeychainSetUserInteractionAllowed(true);
  CFRelease(q);
  free(service);
  free(account);
  CFDataRef data = (st == errSecSuccess && found && CFGetTypeID(found) == CFDataGetTypeID()) ? (CFDataRef)found : NULL;
  napi_value out = result(env, st, data);
  if (found) CFRelease(found);
  return out;
}

// Updates the item in place (its access list stays as created), or adds it.
static napi_value write_item(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char *service = arg_string(env, argv[0]);
  char *account = arg_string(env, argv[1]);
  char *label = arg_string(env, argv[2]);
  void *bytes = NULL;
  size_t len = 0;
  if (!service || !account || !label || napi_get_buffer_info(env, argv[3], &bytes, &len) != napi_ok) {
    free(service);
    free(account);
    free(label);
    return result(env, errSecParam, NULL);
  }
  CFDataRef data = CFDataCreate(NULL, bytes, (CFIndex)len);

  CFMutableDictionaryRef q = item_query(service, account);
  no_ui(q);
  CFMutableDictionaryRef change =
      CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFDictionarySetValue(change, kSecValueData, data);
  SecKeychainSetUserInteractionAllowed(false);
  OSStatus st = SecItemUpdate(q, change);
  SecKeychainSetUserInteractionAllowed(true);
  CFRelease(change);
  CFRelease(q);

  if (st == errSecItemNotFound) {
    CFMutableDictionaryRef add = item_query(service, account);
    CFStringRef l = CFStringCreateWithCString(NULL, label, kCFStringEncodingUTF8);
    CFDictionarySetValue(add, kSecAttrLabel, l);
    CFRelease(l);
    CFDictionarySetValue(add, kSecValueData, data);
    // No kSecAttrAccess: the default access list trusts only this program.
    // A locked keychain fails instead of asking the user to unlock it.
    SecKeychainSetUserInteractionAllowed(false);
    st = SecItemAdd(add, NULL);
    SecKeychainSetUserInteractionAllowed(true);
    CFRelease(add);
  }
  CFRelease(data);
  free(service);
  free(account);
  free(label);
  return result(env, st, NULL);
}

static napi_value remove_item(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char *service = arg_string(env, argv[0]);
  char *account = arg_string(env, argv[1]);
  if (!service || !account) {
    free(service);
    free(account);
    return result(env, errSecParam, NULL);
  }
  CFMutableDictionaryRef q = item_query(service, account);
  no_ui(q);
  SecKeychainSetUserInteractionAllowed(false);
  OSStatus st = SecItemDelete(q);
  SecKeychainSetUserInteractionAllowed(true);
  CFRelease(q);
  free(service);
  free(account);
  return result(env, st, NULL);
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
      {"read", NULL, read_item, NULL, NULL, NULL, napi_default, NULL},
      {"write", NULL, write_item, NULL, NULL, NULL, napi_default, NULL},
      {"remove", NULL, remove_item, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, sizeof props / sizeof props[0], props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
