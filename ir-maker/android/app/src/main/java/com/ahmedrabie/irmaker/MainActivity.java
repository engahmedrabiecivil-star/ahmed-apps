package com.ahmedrabie.irmaker;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

import java.io.OutputStream;

public class MainActivity extends Activity {
    private static final int FILE_REQ = 4001;
    private static final String FOLDER = Environment.DIRECTORY_DOWNLOADS + "/IR Maker/";
    private WebView web;
    private ValueCallback<Uri[]> pendingChooser;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        getWindow().setStatusBarColor(0xFFF7FAFD);
        getWindow().setNavigationBarColor(0xFFFFFFFF);
        getWindow().getDecorView().setSystemUiVisibility(android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web = new WebView(this);
        web.setBackgroundColor(0xFFF4F8FC);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingChooser != null) pendingChooser.onReceiveValue(null);
                pendingChooser = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(pick, "Choose file"), FILE_REQ);
                } catch (ActivityNotFoundException e) {
                    pendingChooser = null;
                    return false;
                }
                return true;
            }
        });

        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        setContentView(web);
        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl("https://appassets.androidplatform.net/assets/index.html");
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_REQ || pendingChooser == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null && data.getData() != null) result = new Uri[]{data.getData()};
        pendingChooser.onReceiveValue(result);
        pendingChooser = null;
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    private Uri findExisting(ContentResolver cr, String name) {
        Uri coll = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
        String sel = MediaStore.MediaColumns.DISPLAY_NAME + "=? AND " + MediaStore.MediaColumns.RELATIVE_PATH + "=?";
        try (Cursor c = cr.query(coll, new String[]{MediaStore.MediaColumns._ID}, sel, new String[]{name, FOLDER}, null)) {
            if (c != null && c.moveToFirst()) {
                long id = c.getLong(0);
                return Uri.withAppendedPath(coll, String.valueOf(id));
            }
        } catch (Exception ignored) { }
        return null;
    }

    class Bridge {
        @JavascriptInterface
        public String saveFile(String name, String base64, String mime, boolean open) {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                ContentResolver cr = getContentResolver();
                Uri uri = findExisting(cr, name);
                if (uri == null) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, FOLDER);
                    uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                }
                if (uri == null) throw new IllegalStateException("can't create file");
                try (OutputStream os = cr.openOutputStream(uri, "wt")) {
                    if (os == null) throw new IllegalStateException("can't open file");
                    os.write(bytes);
                }
                final Uri fileUri = uri;
                if (open) {
                    runOnUiThread(() -> {
                        Intent view = new Intent(Intent.ACTION_VIEW);
                        view.setDataAndType(fileUri, mime);
                        view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        try {
                            startActivity(Intent.createChooser(view, "Open the IR to print"));
                        } catch (ActivityNotFoundException e) {
                            Toast.makeText(MainActivity.this, "Install Word or WPS Office to open the form", Toast.LENGTH_LONG).show();
                        }
                    });
                } else {
                    runOnUiThread(() -> Toast.makeText(MainActivity.this, "Saved to Download/IR Maker: " + name, Toast.LENGTH_SHORT).show());
                }
                return uri.toString();
            } catch (Exception e) {
                final String m = e.getMessage();
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Save failed: " + m, Toast.LENGTH_LONG).show());
                return "";
            }
        }
    }
}
