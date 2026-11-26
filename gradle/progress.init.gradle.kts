// devdash: grava eventos JSON (um por linha) do build em -PdevdashEvents=<arquivo>.
//   {"t":"plan","build":"...","root":bool,"total":N}           grafo pronto (uma vez por build; root = build raiz)
//   {"t":"task","path":":app:x","outcome":"EXECUTED|UP-TO-DATE|FROM-CACHE|SKIPPED|FAILED","start":ms,"end":ms}
//   {"t":"end","tasksFailed":bool}                             fim do build raiz (só falhas de task; o resultado oficial vem do wrapper)
// Usa BuildService + OperationCompletionListener (compatível com configuration cache).
import org.gradle.api.provider.Property
import org.gradle.api.services.BuildService
import org.gradle.api.services.BuildServiceParameters
import org.gradle.build.event.BuildEventsListenerRegistry
import org.gradle.tooling.events.FinishEvent
import org.gradle.tooling.events.OperationCompletionListener
import org.gradle.tooling.events.task.TaskFailureResult
import org.gradle.tooling.events.task.TaskFinishEvent
import org.gradle.tooling.events.task.TaskSkippedResult
import org.gradle.tooling.events.task.TaskSuccessResult
import java.io.File
import javax.inject.Inject

abstract class DevdashListener : BuildService<DevdashListener.Params>, OperationCompletionListener, AutoCloseable {
    interface Params : BuildServiceParameters {
        val file: Property<String>
    }

    @Volatile
    private var failed = false

    private fun write(line: String) {
        synchronized(DevdashListener::class.java) {
            File(parameters.file.get()).appendText(line + "\n")
        }
    }

    override fun onFinish(event: FinishEvent) {
        if (event !is TaskFinishEvent) return
        val r = event.result
        val outcome = when (r) {
            is TaskFailureResult -> "FAILED"
            is TaskSkippedResult -> "SKIPPED"
            is TaskSuccessResult -> if (r.isFromCache) "FROM-CACHE" else if (r.isUpToDate) "UP-TO-DATE" else "EXECUTED"
            else -> "EXECUTED"
        }
        if (outcome == "FAILED") failed = true
        val path = event.descriptor.taskPath.replace("\\", "\\\\").replace("\"", "\\\"")
        write("""{"t":"task","path":"$path","outcome":"$outcome","start":${r.startTime},"end":${r.endTime}}""")
    }

    override fun close() {
        write("""{"t":"end","tasksFailed":$failed}""")
    }
}

abstract class DevdashInjected {
    @get:Inject
    abstract val registry: BuildEventsListenerRegistry
}

val devdashFile: String? = gradle.startParameter.projectProperties["devdashEvents"]

if (devdashFile != null) {
    // total de tasks de cada build (raiz + plugins incluídos)
    gradle.taskGraph.whenReady {
        val total = allTasks.size
        val name = gradle.rootProject.name.replace("\"", "'")
        synchronized(DevdashListener::class.java) {
            File(devdashFile).appendText("""{"t":"plan","build":"$name","root":${gradle.parent == null},"total":$total}""" + "\n")
        }
    }

    // o listener de conclusão só no build raiz (os incluídos já chegam por ele)
    if (gradle.parent == null) {
        gradle.rootProject {
            val svc = gradle.sharedServices.registerIfAbsent("devdashListener", DevdashListener::class.java) {
                parameters.file.set(devdashFile)
            }
            objects.newInstance(DevdashInjected::class.java).registry.onTaskCompletion(svc)
        }
    }
}
