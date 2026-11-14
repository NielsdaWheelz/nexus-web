# browse section headings differ from kind tabs

browse tabs say pdfs, epubs and articles while section headings say PDF, EPUB and Web Article. these name the same resource kinds with different copy.

evidence: BrowsePaneBody.tsx publishes lowercase plural views; the browse section presentation retains existing kind headings. collation candidate chromium-dark-case-08-1.png shows both conventions.

resolve by giving product-authored kind names one appropriate source and aligning the headings with their tabs; source brands retain their spelling.
