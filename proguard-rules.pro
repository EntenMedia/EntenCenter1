# EntenCenter Android ProGuard / R8 Regeln
-keepattributes JavascriptInterface, *Annotation*
-keepclassmembers class de.entencenter.app.MainActivity {
    public *;
}
-keep class de.entencenter.app.MainActivity$AndroidBridge {
    *;
}
-keep class de.entencenter.app.FritzBoxSessionHelper {
    *;
}
-keep class de.entencenter.app.FritzBoxSessionHelper$* {
    *;
}
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
