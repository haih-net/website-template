vcl 4.1;

backend default {
    .host = "haih-site-origin";
    .port = "3000";
}

sub vcl_recv {
    # Voice transports require a tunnel for the upgraded connection.
    if (req.http.Upgrade ~ "(?i)websocket" && req.url ~ "^/api/(voice/messages|codex/voice)([?]|$)") {
        return (pipe);
    }
    # API health and application responses must not be served from cache.
    if (req.url ~ "^/api([/?]|$)") {
        return (pass);
    }
    if (req.method != "GET" && req.method != "HEAD") {
        return (pass);
    }
    unset req.http.Cookie;
    return (hash);
}

sub vcl_hash {
    hash_data(req.url);
    hash_data(req.http.host);
    return (lookup);
}

sub vcl_backend_response {
    if (beresp.status != 200) {
        set beresp.uncacheable = true;
        set beresp.ttl = 0s;
        return (deliver);
    }
    unset beresp.http.Set-Cookie;
    if (bereq.url ~ "\.(js|css|woff2?|ttf|eot|svg|ico|png|jpg|jpeg|gif|webp|avif)(\?.*)?$") {
        set beresp.ttl = 7d;
    } else {
        set beresp.ttl = 1h;
    }
}

sub vcl_deliver {
    if (obj.hits > 0) {
        set resp.http.X-Cache = "HIT";
    } else {
        set resp.http.X-Cache = "MISS";
    }
    set resp.http.X-Cache-TTL = obj.ttl;
}

sub vcl_pipe {
    if (req.http.Upgrade) {
        set bereq.http.Upgrade = req.http.Upgrade;
        set bereq.http.Connection = "upgrade";
    }
}

sub vcl_backend_fetch {
    # File dictation can take up to 330 seconds without response bytes.
    if (bereq.url ~ "^/api([/?]|$)") {
        set bereq.first_byte_timeout = 360s;
    }
}
