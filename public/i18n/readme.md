思源支持的 i18n 文件范围，可以在控制台 `siyuan.config.langs` 中查看。以下是目前（3.7.0 起）推荐的语言方案：

The range of i18n files supported by SiYuan can be viewed in the console under `siyuan.config.langs`. Below are the recommended language schemes since 3.7.0:

```js
>>> siyuan.config.langs.map( lang => lang.name)
['de', 'en', 'es', 'fr', 'he', 'it', 'ja', 'pl', 'ru', 'zh-TW', 'zh-CN']
```

在插件开发中，默认使用 JSON 格式作为国际化（i18n）的载体文件。

为兼容旧版本，过渡期内你仍可保留历史下划线文件名（如 `zh_CN.json`、`en_US.json`）。


