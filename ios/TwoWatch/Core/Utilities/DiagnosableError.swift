/// Un errore che sa dire a **noi** piu' di quanto dica all'utente.
///
/// PERCHE' ESISTE — §5.1 di docs/context/IOS_CODE_STYLE.md chiede due cose
/// insieme: all'utente va una frase di dominio, a Crashlytics va l'errore
/// tecnico. Finche' i due testi erano lo stesso campo (`errorDescription`) si
/// poteva soddisfarne solo uno: ripulire il messaggio per lo schermo
/// significava **perdere la diagnosi**, tenerlo significava mostrare JSON.
///
/// Il caso che l'ha resa necessaria e' `CloudFunctionsCaller.CallableError`:
/// il body della risposta e lo status gRPC sono esattamente cio' che serve per
/// capire un guasto, ed esattamente cio' che l'utente non deve leggere.
///
/// Implementalo quando un errore ha un dettaglio tecnico che vale la pena
/// registrare. Se `errorDescription` gia' dice tutto, non serve.
protocol DiagnosableError {
    /// Cosa finisce nel report. Puo' contenere codici, status e corpi di
    /// risposta troncati — mai PII.
    var diagnosticDescription: String { get }
}
