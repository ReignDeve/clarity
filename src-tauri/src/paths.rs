//! Path normalisation for case-insensitive Windows path comparisons.

use std::path::{Component, Path};

/// Lower-case, backslash-separated, without verbatim prefix or trailing
/// separator (drive roots keep theirs: `c:\`).
pub fn normalize(path: &Path) -> String {
    let mut s = path.to_string_lossy().replace('/', "\\");
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        s = format!(r"\\{rest}");
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        s = rest.to_string();
    }
    let mut s = s.to_lowercase();
    while s.len() > 3 && s.ends_with('\\') {
        s.pop();
    }
    if s.len() == 2 && s.ends_with(':') {
        s.push('\\');
    }
    s
}

/// If `target` lies strictly below `base` (both normalized), return the
/// remaining relative part.
pub fn strip_under<'a>(target: &'a str, base: &str) -> Option<&'a str> {
    if base.ends_with('\\') {
        let rest = target.strip_prefix(base)?;
        (!rest.is_empty()).then_some(rest)
    } else {
        let rest = target.strip_prefix(base)?.strip_prefix('\\')?;
        (!rest.is_empty()).then_some(rest)
    }
}

/// `target` equals `base` or lies below it (both normalized).
pub fn is_same_or_under(target: &str, base: &str) -> bool {
    target == base || strip_under(target, base).is_some()
}

/// Absolute, free of `.`/`..` components and of device namespaces.
pub fn is_plain_absolute(path: &Path) -> bool {
    let s = path.to_string_lossy();
    if s.starts_with(r"\\.\") || s.starts_with(r"\\?\GLOBALROOT") {
        return false;
    }
    path.is_absolute()
        && path
            .components()
            .all(|c| !matches!(c, Component::ParentDir | Component::CurDir))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes() {
        assert_eq!(normalize(Path::new(r"C:\Users\Me\")), r"c:\users\me");
        assert_eq!(normalize(Path::new(r"\\?\C:\Data")), r"c:\data");
        assert_eq!(normalize(Path::new("C:")), r"c:\");
        assert_eq!(normalize(Path::new(r"C:\")), r"c:\");
        assert_eq!(normalize(Path::new("C:/a/b")), r"c:\a\b");
    }

    #[test]
    fn under() {
        assert_eq!(strip_under(r"c:\users\me", r"c:\users"), Some("me"));
        assert_eq!(strip_under(r"c:\users2", r"c:\users"), None);
        assert_eq!(strip_under(r"c:\users", r"c:\users"), None);
        assert_eq!(strip_under(r"c:\x", r"c:\"), Some("x"));
        assert!(is_same_or_under(r"c:\windows", r"c:\windows"));
        assert!(!is_same_or_under(r"c:\windowsapps", r"c:\windows"));
    }

    #[cfg(windows)]
    #[test]
    fn plain_absolute() {
        assert!(is_plain_absolute(Path::new(r"C:\a\b")));
        assert!(!is_plain_absolute(Path::new(r"C:\a\..\b")));
        assert!(!is_plain_absolute(Path::new(r"a\b")));
        assert!(!is_plain_absolute(Path::new(r"\\.\PhysicalDrive0")));
    }
}
