using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.RegularExpressions;

internal static class NetworkEncoding
{
    static NetworkEncoding() => Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

    // Response priority: explicit > BOM > HTTP > meta > UTF-8; explicit/BOM conflicts fail, never guess another encoding.
    public static (string text, string charset) Decode(byte[] bytes, string contentType, string asked, bool lenient = false)
    {
        ArgumentNullException.ThrowIfNull(bytes);
        var bom = Bom(bytes);
        string selected = !string.IsNullOrWhiteSpace(asked) ? asked : bom.charset ?? Charset(contentType);
        if (selected == null)
        {
            string prefix = Encoding.Latin1.GetString(bytes, 0, Math.Min(bytes.Length, 4096));
            foreach (Match meta in Regex.Matches(prefix, @"<meta\b[^>]*>", RegexOptions.IgnoreCase))
            {
                selected = Charset(meta.Value[..^1].TrimEnd('/'));
                if (selected != null) break;
            }
        }
        var encoding = Resolve(selected ?? "utf-8", lenient, out string charset);
        if (!string.IsNullOrWhiteSpace(asked) && bom.charset != null &&
            encoding.CodePage != Resolve(bom.charset, false, out _).CodePage)
            throw Error(charset, "Explicit response charset conflicts with " + bom.charset + " BOM");
        try { return (encoding.GetString(bytes, bom.length, bytes.Length - bom.length), charset); }
        catch (DecoderFallbackException e) { throw Error(charset, "Illegal response bytes: " + e.Message, e); }
    }

    public static HttpContent CreateContent(string body, string contentType, string requestCharset)
    {
        ArgumentNullException.ThrowIfNull(body);
        var type = MediaTypeHeaderValue.Parse(string.IsNullOrWhiteSpace(contentType) ? "application/x-www-form-urlencoded" : contentType);
        string selected = !string.IsNullOrWhiteSpace(requestCharset) ? requestCharset : type.CharSet;
        var encoding = Resolve(selected ?? "utf-8", false, out string charset);
        byte[] bytes;
        try
        {
            if (type.MediaType.Equals("application/x-www-form-urlencoded", StringComparison.OrdinalIgnoreCase))
            {
                // Only raw non-ASCII is encoded; existing %HH, '+', keys and separators stay byte-for-byte unchanged.
                string form = Regex.Replace(body, @"[^\x00-\x7F]+", match =>
                {
                    var encoded = encoding.GetBytes(match.Value);
                    var result = new StringBuilder(encoded.Length * 3);
                    foreach (byte b in encoded) result.Append('%').Append(b.ToString("X2"));
                    return result.ToString();
                });
                bytes = Encoding.ASCII.GetBytes(form);
            }
            else bytes = encoding.GetBytes(body);
        }
        catch (EncoderFallbackException e) { throw Error(charset, "Unencodable request body: " + e.Message, e); }
        type.CharSet = charset;
        var content = new ByteArrayContent(bytes);
        content.Headers.ContentType = type;
        return content;
    }

    private static string Charset(string declaration)
    {
        if (string.IsNullOrEmpty(declaration)) return null;
        var match = Regex.Match(declaration, "\\bcharset\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s;\"']*))", RegexOptions.IgnoreCase);
        if (!match.Success) return null;
        for (int i = 1; i <= 3; i++) if (match.Groups[i].Success) return match.Groups[i].Value;
        return null;
    }

    private static Encoding Resolve(string name, bool lenient, out string charset)
    {
        charset = name.Trim().Trim('"', '\'').Trim().ToLowerInvariant() switch
        {
            "utf8" or "utf_8" or "unicode-1-1-utf-8" => "utf-8",
            "gb2312" or "gb_2312" or "gb_2312-80" or "gb-2312-80" or "x-gbk" or "cp936" or "ms936" or "windows-936" => "gbk",
            "big5hkscs" or "big5-hkscs" or "big5_hkscs" or "cp950" or "windows-950" => "big5",
            "utf16" or "utf-16le" => "utf-16",
            "utf16be" => "utf-16be",
            "utf32" or "utf-32le" => "utf-32",
            "utf32be" => "utf-32be",
            "latin1" or "iso-8859-1" or "iso88591" or "iso8859-1" => "windows-1252",
            var value => value
        };
        try
        {
            var encoding = Encoding.GetEncoding(charset, EncoderFallback.ExceptionFallback,
                lenient ? new DecoderReplacementFallback("\uFFFD") : DecoderFallback.ExceptionFallback);
            charset = encoding.CodePage switch { 936 => "gbk", 950 => "big5", _ => encoding.WebName.ToLowerInvariant() };
            return encoding;
        }
        catch (ArgumentException e) { throw Error(charset, "Unknown charset", e); }
        catch (NotSupportedException e) { throw Error(charset, "Unsupported charset", e); }
    }

    private static (string charset, int length) Bom(byte[] bytes)
    {
        if (bytes.Length >= 4)
        {
            if (bytes[0] == 0xFF && bytes[1] == 0xFE && bytes[2] == 0 && bytes[3] == 0) return ("utf-32", 4);
            if (bytes[0] == 0 && bytes[1] == 0 && bytes[2] == 0xFE && bytes[3] == 0xFF) return ("utf-32be", 4);
        }
        if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF) return ("utf-8", 3);
        if (bytes.Length >= 2)
        {
            if (bytes[0] == 0xFF && bytes[1] == 0xFE) return ("utf-16", 2);
            if (bytes[0] == 0xFE && bytes[1] == 0xFF) return ("utf-16be", 2);
        }
        return (null, 0);
    }

    private static Exception Error(string charset, string message, Exception inner = null)
    {
        var error = new Exception("ENCODING: " + message + " (charset=" + charset + ")", inner);
        error.Data["code"] = "ENCODING";
        error.Data["charset"] = charset;
        return error;
    }
}
